import type {
  Consent,
  Customer,
  FinancialProduct,
  RecurringPayment,
} from '../domain/types.js';
import type { BatchRecord, MigrationStore, TenantContext } from '../store/types.js';
import { MigrationService, newId, ValidationError } from '../api/service.js';
import type { ConnectivityProvider, SkippedAccount } from '../connectivity/types.js';

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
   * Import a population. A row that cannot be materialised is recorded as a
   * failure and skipped — never thrown, because one malformed record in a
   * 500,000-row file must not abort the other 499,999.
   */
  async importRows(
    ctx: TenantContext,
    batchId: string,
    rows: ImportRow[],
  ): Promise<{ imported: string[]; failures: BatchFailure[] }> {
    const batch = await this.store.getBatch(ctx, batchId);
    if (!batch) throw new ValidationError(`Unknown batch ${batchId}`, 'batch_id');

    const imported: string[] = [];
    const failures: BatchFailure[] = [];

    for (const row of rows) {
      try {
        const customerId = newId('cus');

        if (row.products.length === 0) {
          throw new Error('no financial products supplied');
        }

        const customer = this.newCustomer(ctx, batch.originInstitutionId, customerId, row);
        await this.store.putCustomer(ctx, customer);

        await this.store.putProducts(
          ctx,
          row.products.map((p, i) => ({
            ...p,
            id: `${customerId}_p${i}`,
            accountId: `${customerId}_a${i}`,
            customerId,
            institutionId: batch.originInstitutionId,
          })),
        );

        await this.store.putRecurringPayments(
          ctx,
          (row.recurringPayments ?? []).map((p, i) => ({
            ...p,
            id: `${customerId}_r${i}`,
            accountId: `${customerId}_a0`,
            customerId,
          })),
        );

        imported.push(customerId);
      } catch (err) {
        failures.push({
          externalRef: row.externalRef,
          customerId: null,
          reason: err instanceof Error ? err.message : String(err),
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

    const imported: string[] = [];
    const failures: BatchFailure[] = [];
    const skippedAccounts: ProviderImportResult['skippedAccounts'] = [];

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
        await this.store.putCustomer(ctx, customer);
        await this.store.putProducts(ctx, products);
        // Recurring payments aren't part of this path: no connectivity
        // provider here detects them (Powens doesn't — see README Milestone
        // 4). A row that wants recurring payments imported still goes
        // through importRows.

        imported.push(customerId);
        for (const s of skipped) {
          skippedAccounts.push({ ...s, customerId, externalRef: row.externalRef });
        }
      } catch (err) {
        failures.push({
          externalRef: row.externalRef,
          customerId: null,
          reason: err instanceof Error ? err.message : String(err),
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

  /** Plan every imported customer in bounded-concurrency chunks. */
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
      const results = await Promise.allSettled(
        chunk.map((customerId) =>
          this.service.createMigration(ctx, {
            customerId,
            destinationInstitutionId: batch.destinationInstitutionId,
            batchId,
            // Idempotent per (batch, customer): re-running a partially failed
            // batch resumes rather than duplicating migrations.
            idempotencyKey: `${batchId}:${customerId}`,
          }),
        ),
      );

      results.forEach((result, idx) => {
        const customerId = chunk[idx]!;
        if (result.status === 'fulfilled') {
          planned++;
          if (result.value.record.blockingExceptionCount > 0) blocked++;
        } else {
          failures.push({
            externalRef: customerId,
            customerId,
            reason:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            stage: 'PLAN',
          });
        }
      });

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
