import type {
  Consent,
  Customer,
  FinancialProduct,
  RecurringPayment,
  Transaction,
} from '../domain/types.js';
import type {
  BatchRecord,
  MigrationStore,
  PreparedMigration,
  TenantContext,
} from '../store/types.js';
import { MigrationService, newId, ValidationError } from '../api/service.js';
import type { ConnectivityProvider, SkippedAccount } from '../connectivity/types.js';
import { detectRecurringPayments as runRecurringDetection } from '../detection/recurring.js';

/**
 * Mass institutional migration (§20 of the brief).
 *
 * The important difference from the single-customer path is not volume, it is
 * failure handling. Planning 500,000 customers means some thousands will fail —
 * missing data, unsupported products, expired consent — and the run must not
 * stop for any of them. Every failure is captured with the customer it belongs
 * to and lands in an exception queue an operations team can work through, while
 * the rest of the population proceeds.
 */

/** Customer-identity fields every import row carries, whatever it carries them for. */
export interface ImportRowIdentity {
  externalRef: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  fiscalResidence?: string;
  consentScopes?: Consent['scopes'];
  consentExpiresAt?: string;
}

export interface ImportRow extends ImportRowIdentity {
  products: Omit<
    FinancialProduct,
    'id' | 'customerId' | 'institutionId' | 'accountId'
  >[];
  recurringPayments?: Omit<RecurringPayment, 'id' | 'customerId' | 'accountId'>[];
}

/**
 * A row for `importFromProvider` — the accounts arrive exactly as the
 * provider returned them, unnormalized. Everything downstream of
 * `provider.normalizeAccounts` is identical to the plain `importRows` path.
 */
export interface ProviderImportRow extends ImportRowIdentity {
  rawAccounts: unknown[];
}

export interface ProviderImportResult {
  imported: string[];
  failures: BatchFailure[];
  /** Accounts the provider returned that no product type could be assigned to — reported, not dropped. */
  skippedAccounts: (SkippedAccount & { customerId: string; externalRef: string })[];
}

export interface RecurringPaymentDetectionResult {
  customerId: string;
  detected: RecurringPayment[];
  skippedTransactions: { externalTransactionId: string; reason: string; accountId: string }[];
}

export interface BatchFailure {
  externalRef: string;
  customerId: string | null;
  reason: string;
  stage: 'IMPORT' | 'PLAN';
}

export interface BatchResult {
  batch: BatchRecord;
  planned: number;
  failed: number;
  blocked: number;
  failures: BatchFailure[];
}

export interface BatchOptions {
  /** How many customers to plan at once. Bounded so one run cannot exhaust a pool. */
  concurrency?: number;
  /** Called after each chunk — wire to a progress bar or a webhook. */
  onProgress?: (done: number, total: number) => void;
}

/** A customer + its rows, ready for `store.importCustomers` — see `persistChunked`. */
interface PreparedImportRow {
  externalRef: string;
  customerId: string;
  customer: Customer;
  products: FinancialProduct[];
  recurringPayments: RecurringPayment[];
}

/**
 * Customers per `store.importCustomers` call. Large enough that a 500,000-row
 * import spends its time on the database, not the round trip to reach it;
 * small enough to stay well under Postgres' ~65,535 bound-parameter limit
 * even for a chunk of unusually product-heavy customers (200 customers × a
 * generous 10 products each × `financial_products`' 13 columns is ~26,000).
 * The same ceiling `planBatch` already uses for concurrency — not a
 * coincidence, both exist to bound how much one round trip is asked to do.
 */
const IMPORT_CHUNK_SIZE = 200;

export class BatchPipeline {
  constructor(
    private readonly store: MigrationStore,
    private readonly service: MigrationService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createBatch(
    ctx: TenantContext,
    params: { name: string; originInstitutionId: string; destinationInstitutionId: string },
  ): Promise<BatchRecord> {
    const origin = await this.store.getInstitution(ctx, params.originInstitutionId);
    const destination = await this.store.getInstitution(ctx, params.destinationInstitutionId);
    if (!origin) throw new ValidationError('Unknown origin institution', 'origin_institution_id');
    if (!destination) {
      throw new ValidationError('Unknown destination institution', 'destination_institution_id');
    }

    const batch: BatchRecord = {
      id: newId('bat'),
      tenantId: ctx.tenantId,
      name: params.name,
      originInstitutionId: origin.id,
      destinationInstitutionId: destination.id,
      status: 'IMPORTING',
      totalCustomers: 0,
      plannedCount: 0,
      failedCount: 0,
      blockedCount: 0,
      createdAt: this.clock().toISOString(),
      completedAt: null,
    };
    await this.store.createBatch(ctx, batch);
    return batch;
  }

  /** Shared by every import path: the consent + identity fields every row carries. */
  private newCustomer(
    ctx: TenantContext,
    institutionId: string,
    customerId: string,
    row: ImportRowIdentity,
  ): Customer {
    const consent: Consent = {
      id: newId('con'),
      scopes: row.consentScopes ?? [
        'ACCOUNT_INFORMATION',
        'TRANSACTION_HISTORY',
        'MIGRATION_EXECUTION',
      ],
      grantedAt: this.clock().toISOString(),
      expiresAt:
        row.consentExpiresAt ?? new Date(this.clock().getTime() + 365 * 864e5).toISOString(),
    };
    return {
      id: customerId,
      tenantId: ctx.tenantId,
      institutionId,
      identity: {
        firstName: row.firstName,
        lastName: row.lastName,
        dateOfBirth: row.dateOfBirth,
        countryOfResidence: 'FR',
        fiscalResidence: (row.fiscalResidence as Customer['identity']['fiscalResidence']) ?? 'FR',
      },
      consent,
      migrationIds: [],
    };
  }

  /**
   * Persist prepared rows in chunks of `IMPORT_CHUNK_SIZE`, batching the
   * writes across customers via `store.importCustomers` — one round trip per
   * chunk instead of one (Postgres: three) per customer. That is the whole
   * point, and it has a real cost: `store.importCustomers` runs a chunk in a
   * single transaction, so a customer whose data the database itself rejects
   * (not something the in-app validation above already catches — a malformed
   * date of birth, say) would otherwise take the rest of its chunk down with
   * it.
   *
   * The fix is not a second, more careful write path — it's retrying the
   * exact same call with a batch of one for every customer in a chunk that
   * failed. That is slow only for the chunk that actually had a problem, and
   * it is the same code, so there is no separate "careful" path to keep in
   * sync with the fast one. This is what gets back the per-customer failure
   * isolation `importRows` has always guaranteed, at the cost of one retry
   * pass only on the (expected to be rare) chunk that needs it.
   */
  private async persistChunked(
    ctx: TenantContext,
    prepared: PreparedImportRow[],
  ): Promise<{ succeeded: Set<string>; failed: Map<string, string> }> {
    const succeeded = new Set<string>();
    const failed = new Map<string, string>();

    for (let i = 0; i < prepared.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = prepared.slice(i, i + IMPORT_CHUNK_SIZE);
      try {
        await this.store.importCustomers(ctx, chunk);
        for (const row of chunk) succeeded.add(row.customerId);
      } catch {
        for (const row of chunk) {
          try {
            await this.store.importCustomers(ctx, [row]);
            succeeded.add(row.customerId);
          } catch (err) {
            failed.set(row.customerId, err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    return { succeeded, failed };
  }

  /**
   * Import a population. A row that cannot be materialised is recorded as a
   * failure and skipped — never thrown, because one malformed record in a
   * 500,000-row file must not abort the other 499,999. See `persistChunked`
   * for how that guarantee survives batching the writes across customers.
   */
  async importRows(
    ctx: TenantContext,
    batchId: string,
    rows: ImportRow[],
  ): Promise<{ imported: string[]; failures: BatchFailure[] }> {
    const batch = await this.store.getBatch(ctx, batchId);
    if (!batch) throw new ValidationError(`Unknown batch ${batchId}`, 'batch_id');

    const prepared: PreparedImportRow[] = [];
    const failures: BatchFailure[] = [];

    for (const row of rows) {
      try {
        const customerId = newId('cus');

        if (row.products.length === 0) {
          throw new Error('no financial products supplied');
        }

        const customer = this.newCustomer(ctx, batch.originInstitutionId, customerId, row);
        const products = row.products.map((p, i) => ({
          ...p,
          id: `${customerId}_p${i}`,
          accountId: `${customerId}_a${i}`,
          customerId,
          institutionId: batch.originInstitutionId,
        }));
        const recurringPayments = (row.recurringPayments ?? []).map((p, i) => ({
          ...p,
          id: `${customerId}_r${i}`,
          accountId: `${customerId}_a0`,
          customerId,
        }));

        prepared.push({ externalRef: row.externalRef, customerId, customer, products, recurringPayments });
      } catch (err) {
        failures.push({
          externalRef: row.externalRef,
          customerId: null,
          reason: err instanceof Error ? err.message : String(err),
          stage: 'IMPORT',
        });
      }
    }

    const { succeeded, failed } = await this.persistChunked(ctx, prepared);
    const imported: string[] = [];
    for (const row of prepared) {
      if (succeeded.has(row.customerId)) {
        imported.push(row.customerId);
      } else {
        failures.push({
          externalRef: row.externalRef,
          customerId: null,
          reason: failed.get(row.customerId) ?? 'import failed',
          stage: 'IMPORT',
        });
      }
    }

    await this.store.updateBatch(ctx, batchId, {
      totalCustomers: batch.totalCustomers + imported.length,
      failedCount: batch.failedCount + failures.length,
    });

    return { imported, failures };
  }

  /**
   * Import a population from a connectivity provider's raw accounts, rather
   * than already-normalized `FinancialProduct`s. `provider.normalizeAccounts`
   * does the classification (§5); this method does exactly what `importRows`
   * does with the result — one bad customer, or one customer whose every
   * account came back unclassifiable, is recorded and skipped, never thrown.
   *
   * A customer with SOME accounts skipped still imports: `skippedAccounts`
   * reports what was left out without failing a customer over a partial gap.
   * A customer with ALL accounts skipped is an import failure — the same
   * "no financial products supplied" case `importRows` already treats as one,
   * just arrived at through the provider instead of an empty `products[]`.
   */
  async importFromProvider(
    ctx: TenantContext,
    batchId: string,
    provider: ConnectivityProvider,
    rows: ProviderImportRow[],
  ): Promise<ProviderImportResult> {
    const batch = await this.store.getBatch(ctx, batchId);
    if (!batch) throw new ValidationError(`Unknown batch ${batchId}`, 'batch_id');

    const prepared: (PreparedImportRow & { skipped: SkippedAccount[] })[] = [];
    const failures: BatchFailure[] = [];

    for (const row of rows) {
      try {
        const customerId = newId('cus');
        const { products, skipped } = provider.normalizeAccounts(row.rawAccounts, {
          customerId,
          institutionId: batch.originInstitutionId,
        });

        if (products.length === 0) {
          throw new Error(
            skipped.length > 0
              ? `every account ${provider.id} returned was unusable: ${skipped
                  .map((s) => s.reason)
                  .join('; ')}`
              : `${provider.id} returned no accounts`,
          );
        }

        const customer = this.newCustomer(ctx, batch.originInstitutionId, customerId, row);
        // Recurring payments aren't part of this path: no connectivity
        // provider here detects them (Powens doesn't — see README Milestone
        // 4). A row that wants recurring payments imported still goes
        // through importRows.
        prepared.push({
          externalRef: row.externalRef,
          customerId,
          customer,
          products,
          recurringPayments: [],
          skipped,
        });
      } catch (err) {
        failures.push({
          externalRef: row.externalRef,
          customerId: null,
          reason: err instanceof Error ? err.message : String(err),
          stage: 'IMPORT',
        });
      }
    }

    const { succeeded, failed } = await this.persistChunked(ctx, prepared);
    const imported: string[] = [];
    const skippedAccounts: ProviderImportResult['skippedAccounts'] = [];
    for (const row of prepared) {
      if (succeeded.has(row.customerId)) {
        imported.push(row.customerId);
        for (const s of row.skipped) {
          skippedAccounts.push({ ...s, customerId: row.customerId, externalRef: row.externalRef });
        }
      } else {
        failures.push({
          externalRef: row.externalRef,
          customerId: null,
          reason: failed.get(row.customerId) ?? 'import failed',
          stage: 'IMPORT',
        });
      }
    }

    await this.store.updateBatch(ctx, batchId, {
      totalCustomers: batch.totalCustomers + imported.length,
      failedCount: batch.failedCount + failures.length,
    });

    return { imported, failures, skippedAccounts };
  }

  /**
   * Run recurring-payment detection (`detection/recurring.ts`) for one
   * customer against a provider's raw transaction history, and persist what
   * it finds. Deliberately per-customer rather than per-batch: transaction
   * volume is much larger than account volume, and a caller decides which
   * customers in a batch are worth the fetch (a fresh import, say, or one
   * flagged for re-detection) rather than this pipeline fetching every
   * customer's full history unconditionally.
   *
   * Once persisted, this needs no further wiring: `MigrationService`
   * already calls `store.listRecurringPayments` when it builds a plan (see
   * `api/service.ts`), so a customer planned after this call sees the
   * detected payments — and a low-confidence one routes into the planner's
   * existing `LOW_CONFIDENCE_RECURRING_PAYMENT` exception — exactly as if
   * they had been imported by hand.
   */
  async detectRecurringPayments(
    ctx: TenantContext,
    customerId: string,
    provider: ConnectivityProvider,
    rawTransactionsByAccount: Record<string, unknown[]>,
  ): Promise<RecurringPaymentDetectionResult> {
    if (!provider.normalizeTransactions) {
      throw new ValidationError(
        `${provider.id} does not support transaction history`,
        'provider',
      );
    }
    const customer = await this.store.getCustomer(ctx, customerId);
    if (!customer) throw new ValidationError(`Unknown customer ${customerId}`, 'customer_id');

    const transactions: Transaction[] = [];
    const skippedTransactions: RecurringPaymentDetectionResult['skippedTransactions'] = [];

    for (const [accountId, raw] of Object.entries(rawTransactionsByAccount)) {
      const { transactions: normalized, skipped } = provider.normalizeTransactions(raw, {
        customerId,
        accountId,
      });
      transactions.push(...normalized);
      for (const s of skipped) skippedTransactions.push({ ...s, accountId });
    }

    const detected = runRecurringDetection(transactions);
    await this.store.putRecurringPayments(ctx, detected);

    return { customerId, detected, skippedTransactions };
  }

  /**
   * Plan every imported customer in bounded-concurrency chunks.
   *
   * Each customer is still validated, read and planned individually — that
   * part was never the cost `createMigration` calls added, and batching
   * reads customers don't share isn't the same tradeoff Milestone 6 made for
   * imports. What used to be one `store.createMigration` transaction (plus,
   * inside it, a follow-up transaction per task, per event and per raised
   * exception) *per customer* is now `service.persistPrepared` writing every
   * customer prepared in this chunk in one round trip — the same
   * batch-across-customers tradeoff Milestone 6 gave `importRows`, applied
   * to planning instead of import.
   */
  async planBatch(
    ctx: TenantContext,
    batchId: string,
    customerIds: string[],
    options: BatchOptions = {},
  ): Promise<BatchResult> {
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 25, 200));
    const batch = await this.store.getBatch(ctx, batchId);
    if (!batch) throw new ValidationError(`Unknown batch ${batchId}`, 'batch_id');

    await this.store.updateBatch(ctx, batchId, { status: 'PLANNING' });

    const failures: BatchFailure[] = [];
    let planned = 0;
    let blocked = 0;
    let done = 0;

    for (let i = 0; i < customerIds.length; i += concurrency) {
      const chunk = customerIds.slice(i, i + concurrency);

      // Validate, plan and simulate each customer's migration in memory,
      // concurrently. Nothing is written yet — that's persistPrepared below.
      const prepareResults = await Promise.allSettled(
        chunk.map((customerId) =>
          this.service.prepareMigration(ctx, {
            customerId,
            destinationInstitutionId: batch.destinationInstitutionId,
            batchId,
            // Idempotent per (batch, customer): re-running a partially failed
            // batch resumes rather than duplicating migrations.
            idempotencyKey: `${batchId}:${customerId}`,
          }),
        ),
      );

      const toPersist: { customerId: string; prepared: PreparedMigration }[] = [];
      prepareResults.forEach((result, idx) => {
        const customerId = chunk[idx]!;
        if (result.status !== 'fulfilled') {
          failures.push({
            externalRef: customerId,
            customerId,
            reason:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            stage: 'PLAN',
          });
          return;
        }
        if (result.value.kind === 'existing') {
          // Idempotency key already resolved — nothing to persist.
          planned++;
          if (result.value.record.blockingExceptionCount > 0) blocked++;
          return;
        }
        toPersist.push({ customerId, prepared: result.value.prepared });
      });

      if (toPersist.length > 0) {
        const { succeeded, failed } = await this.service.persistPrepared(ctx, toPersist);
        for (const { customerId } of toPersist) {
          const record = succeeded.get(customerId);
          if (record) {
            planned++;
            if (record.blockingExceptionCount > 0) blocked++;
          } else {
            failures.push({
              externalRef: customerId,
              customerId,
              reason: failed.get(customerId) ?? 'plan failed',
              stage: 'PLAN',
            });
          }
        }
      }

      done += chunk.length;
      options.onProgress?.(done, customerIds.length);
    }

    const updated = await this.store.updateBatch(ctx, batchId, {
      status: failures.length === customerIds.length && customerIds.length > 0
        ? 'FAILED'
        : 'PLANNED',
      plannedCount: planned,
      blockedCount: blocked,
      failedCount: batch.failedCount + failures.length,
    });

    return { batch: updated, planned, failed: failures.length, blocked, failures };
  }

  /**
   * The exception queue: every open blocking case across the batch, newest
   * first, with the migration and customer it belongs to. This is the working
   * surface for an operations team during a mass migration.
   */
  async exceptionQueue(
    ctx: TenantContext,
    batchId: string,
  ): Promise<
    {
      migrationId: string;
      customerId: string;
      code: string;
      severity: string;
      message: string;
      resolution: string;
    }[]
  > {
    const migrations = await this.store.listMigrations(ctx, { batchId, limit: 10_000 });
    const byId = new Map(migrations.map((m) => [m.id, m]));
    const all = await this.store.listExceptions(ctx, { openOnly: true });

    return all
      .filter((e) => byId.has(e.migrationId))
      .map((e) => ({
        migrationId: e.migrationId,
        customerId: byId.get(e.migrationId)!.customerId,
        code: e.code,
        severity: e.severity,
        message: e.message,
        resolution: e.resolution,
      }))
      .sort((a, b) => {
        const rank = { BLOCKING: 0, WARNING: 1, INFO: 2 } as Record<string, number>;
        return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
      });
  }
}
