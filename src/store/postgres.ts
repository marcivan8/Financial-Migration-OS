import { Pool, type PoolClient } from 'pg';
import type {
  Customer,
  FinancialProduct,
  Institution,
  RecurringPayment,
} from '../domain/types.js';
import type {
  MigrationEvent,
  MigrationException,
  MigrationPlan,
  MigrationTask,
} from '../domain/migration.js';
import type {
  AuditEntry,
  BatchRecord,
  DeliveryStatus,
  MigrationListFilter,
  MigrationRecord,
  MigrationStore,
  PortfolioStats,
  TenantContext,
  WebhookDelivery,
  WebhookEndpoint,
} from './types.js';
import { ConflictError } from './types.js';

/**
 * Postgres adapter, behind the same port `InMemoryStore` implements.
 *
 * Two things the in-memory adapter didn't need to think about:
 *
 * - **Tenant scoping is a transaction property, not a query fragment.** Every
 *   call opens its own transaction, sets `app.tenant_id` via `set_config` (not
 *   string-interpolated `SET LOCAL` — `set_config` is a normal parameterised
 *   call, so a tenant id can never become SQL) and switches to the `fmos_app`
 *   role before touching a row, so RLS enforces the boundary the same way it
 *   would for a bug in this file, not just for a bug in the caller.
 *
 * - **`listDueDeliveries` and `updateDelivery` are the one sanctioned
 *   exception.** They're cross-tenant by the port's own contract, so they run
 *   as `fmos_worker` — a role with BYPASSRLS, but granted on `webhook_deliveries`
 *   alone (db/migrations/0003). Nothing else in this class ever switches to it.
 *
 * `getPlan` returns `plan_snapshot` verbatim rather than reconstructing a
 * `MigrationPlan` from `plan_items` / `migration_tasks` / `migration_exceptions`.
 * Those tables stay populated and are the source of truth for everything that
 * changes after planning (task status, exception resolution, dashboard
 * aggregates) — the snapshot exists only so a plan reads back exactly as the
 * planner produced it, which a relational reconstruction cannot promise once
 * the tables it would read from have been mutated by execution.
 */

export interface PostgresStoreOptions {
  appRole?: string;
  workerRole?: string;
}

const isoOf = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

/**
 * `($1,$2,$3),($4,$5,$6),...` for a multi-row INSERT.
 *
 * A migration with 20 tasks used to mean 20 round trips inside one
 * transaction; a 500-customer batch plan spent most of its ~12s waiting on
 * network round trips rather than the database itself. One statement per
 * table per migration — still one row per array element, just not one
 * network round trip per element.
 */
function valuesPlaceholders(rowCount: number, colCount: number): string {
  const rows: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const cols: string[] = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${p++}`);
    rows.push(`(${cols.join(',')})`);
  }
  return rows.join(',');
}

function pgError(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  if (e?.code === '23505') return new ConflictError(e.message ?? 'unique constraint violated');
  return err as Error;
}

export class PostgresStore implements MigrationStore {
  private constructor(
    private readonly pool: Pool,
    private readonly appRole: string,
    private readonly workerRole: string,
  ) {}

  static connect(connectionString: string, options: PostgresStoreOptions = {}): PostgresStore {
    const pool = new Pool({ connectionString });
    return new PostgresStore(
      pool,
      options.appRole ?? 'fmos_app',
      options.workerRole ?? 'fmos_worker',
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Wipes every tenant-scoped table. Test-only — the name and the guard are
   * both deliberate, so this can never become a production foot-gun that
   * happens to be reachable from application code.
   */
  async resetForTests(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('resetForTests refused: NODE_ENV=production');
    }
    const client = await this.pool.connect();
    try {
      // No RESTART IDENTITY: that requires owning audit_log's and
      // migration_events' sequences, which the test role deliberately
      // doesn't (see db/migrations/0003) — and nothing depends on those
      // ids resetting, only on the tables being empty.
      await client.query(`
        TRUNCATE
          audit_log, migration_events, migration_exceptions, migration_tasks,
          plan_items, migrations, migration_batches, webhook_deliveries,
          webhook_endpoints, recurring_payments, financial_products, consents,
          customers, institutions, api_keys, tenants
        CASCADE
      `);
    } finally {
      client.release();
    }
  }

  /** Every tenant-scoped call: its own transaction, its own tenant context, the RLS-bound role. */
  private async tx<T>(ctx: TenantContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.appRole}`);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw pgError(err);
    } finally {
      client.release();
    }
  }

  /** The one path that deliberately crosses tenants — see class doc. */
  private async workerTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.workerRole}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw pgError(err);
    } finally {
      client.release();
    }
  }

  /** Tenants and institutions referenced by a row must exist before it can be inserted (FKs). */
  private async ensureTenant(c: PoolClient, tenantId: string): Promise<void> {
    await c.query(
      `INSERT INTO tenants (id, name, country) VALUES ($1, $1, 'FR')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId],
    );
  }

  // -- reference data ---------------------------------------------------------

  async putInstitution(ctx: TenantContext, institution: Institution): Promise<void> {
    await this.tx(ctx, async (c) => {
      await this.ensureTenant(c, ctx.tenantId);
      await c.query(
        `INSERT INTO institutions
           (id, tenant_id, name, country, type, bic, supported_products,
            supports_mobility_scheme, supports_securities_in, has_api)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, country = EXCLUDED.country, type = EXCLUDED.type,
           bic = EXCLUDED.bic, supported_products = EXCLUDED.supported_products,
           supports_mobility_scheme = EXCLUDED.supports_mobility_scheme,
           supports_securities_in = EXCLUDED.supports_securities_in,
           has_api = EXCLUDED.has_api`,
        [
          institution.id,
          ctx.tenantId,
          institution.name,
          institution.country,
          institution.type,
          institution.bic ?? null,
          institution.capabilities.supportedProducts,
          institution.capabilities.supportsBankMobilityScheme,
          institution.capabilities.supportsSecuritiesTransferIn,
          institution.capabilities.hasApi,
        ],
      );
    });
  }

  async getInstitution(ctx: TenantContext, id: string): Promise<Institution | null> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT * FROM institutions WHERE id = $1', [id]);
      return rows[0] ? rowToInstitution(rows[0]) : null;
    });
  }

  async listInstitutions(ctx: TenantContext): Promise<Institution[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT * FROM institutions ORDER BY id');
      return rows.map(rowToInstitution);
    });
  }

  // -- customers ----------------------------------------------------------------

  async putCustomer(ctx: TenantContext, customer: Customer): Promise<void> {
    await this.tx(ctx, async (c) => {
      await this.ensureTenant(c, ctx.tenantId);
      await c.query(
        `INSERT INTO customers
           (id, tenant_id, institution_id, first_name, last_name, date_of_birth,
            country_of_residence, fiscal_residence, migration_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           institution_id = EXCLUDED.institution_id, first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name, date_of_birth = EXCLUDED.date_of_birth,
           country_of_residence = EXCLUDED.country_of_residence,
           fiscal_residence = EXCLUDED.fiscal_residence, migration_ids = EXCLUDED.migration_ids`,
        [
          customer.id,
          ctx.tenantId,
          customer.institutionId,
          customer.identity.firstName,
          customer.identity.lastName,
          customer.identity.dateOfBirth,
          customer.identity.countryOfResidence,
          customer.identity.fiscalResidence,
          customer.migrationIds,
        ],
      );
      await c.query(
        `INSERT INTO consents (id, tenant_id, customer_id, scopes, granted_at, expires_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           scopes = EXCLUDED.scopes, granted_at = EXCLUDED.granted_at,
           expires_at = EXCLUDED.expires_at, revoked_at = EXCLUDED.revoked_at`,
        [
          customer.consent.id,
          ctx.tenantId,
          customer.id,
          customer.consent.scopes,
          customer.consent.grantedAt,
          customer.consent.expiresAt,
          customer.consent.revokedAt ?? null,
        ],
      );
    });
  }

  async getCustomer(ctx: TenantContext, id: string): Promise<Customer | null> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT cu.*, cu.date_of_birth::text AS dob_text,
                co.id AS consent_id, co.scopes AS consent_scopes,
                co.granted_at AS consent_granted_at, co.expires_at AS consent_expires_at,
                co.revoked_at AS consent_revoked_at
         FROM customers cu
         LEFT JOIN consents co ON co.customer_id = cu.id
         WHERE cu.id = $1
         ORDER BY co.granted_at DESC
         LIMIT 1`,
        [id],
      );
      return rows[0] ? rowToCustomer(rows[0]) : null;
    });
  }

  async putProducts(ctx: TenantContext, products: FinancialProduct[]): Promise<void> {
    if (products.length === 0) return;
    const COLS = 11;
    await this.tx(ctx, async (c) => {
      const params: unknown[] = [];
      for (const p of products) {
        params.push(
          p.id,
          ctx.tenantId,
          p.customerId,
          p.institutionId,
          p.accountId,
          p.type,
          p.rawLabel,
          p.balance.amount,
          p.balance.currency,
          p.openedAt,
          JSON.stringify({ ...p.metadata, transferable: p.transferable }),
        );
      }
      await c.query(
        `INSERT INTO financial_products
           (id, tenant_id, customer_id, institution_id, account_id, type, raw_label,
            balance_minor, currency, opened_at, metadata)
         VALUES ${valuesPlaceholders(products.length, COLS)}
         ON CONFLICT (id) DO UPDATE SET
           account_id = EXCLUDED.account_id, type = EXCLUDED.type,
           raw_label = EXCLUDED.raw_label, balance_minor = EXCLUDED.balance_minor,
           currency = EXCLUDED.currency, opened_at = EXCLUDED.opened_at,
           metadata = EXCLUDED.metadata`,
        params,
      );
    });
  }

  async listProducts(ctx: TenantContext, customerId: string): Promise<FinancialProduct[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        `SELECT *, opened_at::text AS opened_at_text FROM financial_products
         WHERE customer_id = $1 ORDER BY id`,
        [customerId],
      );
      return rows.map(rowToProduct);
    });
  }

  async putRecurringPayments(ctx: TenantContext, payments: RecurringPayment[]): Promise<void> {
    if (payments.length === 0) return;
    const COLS = 12;
    await this.tx(ctx, async (c) => {
      const params: unknown[] = [];
      for (const p of payments) {
        params.push(
          p.id,
          ctx.tenantId,
          p.customerId,
          p.accountId,
          p.merchant,
          p.amount.amount,
          p.amount.currency,
          p.frequency,
          p.category,
          p.direction,
          p.confidence,
          p.migrationStatus,
        );
      }
      await c.query(
        `INSERT INTO recurring_payments
           (id, tenant_id, customer_id, account_id, merchant, amount_minor, currency,
            frequency, category, direction, confidence, migration_status)
         VALUES ${valuesPlaceholders(payments.length, COLS)}
         ON CONFLICT (id) DO UPDATE SET
           merchant = EXCLUDED.merchant, amount_minor = EXCLUDED.amount_minor,
           currency = EXCLUDED.currency, frequency = EXCLUDED.frequency,
           category = EXCLUDED.category, direction = EXCLUDED.direction,
           confidence = EXCLUDED.confidence, migration_status = EXCLUDED.migration_status`,
        params,
      );
    });
  }

  async listRecurringPayments(
    ctx: TenantContext,
    customerId: string,
  ): Promise<RecurringPayment[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM recurring_payments WHERE customer_id = $1 ORDER BY id',
        [customerId],
      );
      return rows.map(rowToPayment);
    });
  }

  // -- migrations ---------------------------------------------------------------

  async createMigration(
    ctx: TenantContext,
    plan: MigrationPlan,
    options: { idempotencyKey?: string; batchId?: string },
  ): Promise<MigrationRecord> {
    return this.tx(ctx, async (c) => {
      const blockingCount = plan.exceptions.filter((e) => e.severity === 'BLOCKING').length;
      const now = new Date().toISOString();

      let row;
      try {
        row = (
          await c.query(
            `INSERT INTO migrations
               (id, tenant_id, customer_id, origin_institution_id, destination_institution_id,
                batch_id, state, completion, blocking_exception_count, estimated_duration_days,
                estimated_fees_minor, idempotency_key, created_at, updated_at, plan_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,'CREATED',0,$7,$8,$9,$10,$11,$11,$12)
             RETURNING *`,
            [
              plan.migrationId,
              ctx.tenantId,
              plan.customerId,
              plan.originInstitutionId,
              plan.destinationInstitutionId,
              options.batchId ?? null,
              blockingCount,
              plan.estimatedTotalDurationDays,
              plan.estimatedTotalFees.amount,
              options.idempotencyKey ?? null,
              now,
              JSON.stringify(plan),
            ],
          )
        ).rows[0];
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'migrations_tenant_id_idempotency_key_key') {
          throw new ConflictError(
            `idempotency key already used by another migration`,
          );
        }
        throw err;
      }

      if (plan.items.length > 0) {
        const COLS = 16;
        const params: unknown[] = [];
        for (const item of plan.items) {
          params.push(
            item.id,
            ctx.tenantId,
            plan.migrationId,
            item.subject,
            item.subjectId,
            item.productType ?? null,
            item.category,
            item.label,
            item.action,
            item.ruleId,
            item.rationale,
            item.balance?.amount ?? null,
            item.balance?.currency ?? null,
            item.preservesTaxHistory,
            item.estimatedDurationDays,
            item.estimatedFees?.amount ?? 0,
          );
        }
        await c.query(
          `INSERT INTO plan_items
             (id, tenant_id, migration_id, subject, subject_id, product_type, category, label,
              action, rule_id, rationale, balance_minor, currency, preserves_tax_history,
              estimated_duration_days, estimated_fees_minor)
           VALUES ${valuesPlaceholders(plan.items.length, COLS)}`,
          params,
        );
      }

      if (plan.tasks.length > 0) {
        const COLS = 12;
        const position = new Map(plan.executionOrder.map((id, idx) => [id, idx]));
        const params: unknown[] = [];
        plan.tasks.forEach((task, idx) => {
          params.push(
            task.id,
            ctx.tenantId,
            plan.migrationId,
            task.itemId,
            task.type,
            task.label,
            task.status,
            task.actor,
            task.slaDays,
            task.dependencies,
            JSON.stringify(task.documents),
            position.get(task.id) ?? idx,
          );
        });
        await c.query(
          `INSERT INTO migration_tasks
             (id, tenant_id, migration_id, item_id, type, label, status, actor, sla_days,
              dependencies, documents, position)
           VALUES ${valuesPlaceholders(plan.tasks.length, COLS)}`,
          params,
        );
      }

      if (plan.exceptions.length > 0) {
        const COLS = 8;
        const params: unknown[] = [];
        for (const exc of plan.exceptions) {
          params.push(
            exc.id,
            ctx.tenantId,
            plan.migrationId,
            exc.code,
            exc.severity,
            exc.message,
            exc.resolution,
            exc.subjectId,
          );
        }
        await c.query(
          `INSERT INTO migration_exceptions
             (id, tenant_id, migration_id, code, severity, message, resolution, subject_id)
           VALUES ${valuesPlaceholders(plan.exceptions.length, COLS)}`,
          params,
        );
      }

      return rowToMigration(row);
    });
  }

  async findByIdempotencyKey(ctx: TenantContext, key: string): Promise<MigrationRecord | null> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT * FROM migrations WHERE idempotency_key = $1', [
        key,
      ]);
      return rows[0] ? rowToMigration(rows[0]) : null;
    });
  }

  async getMigration(ctx: TenantContext, id: string): Promise<MigrationRecord | null> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT * FROM migrations WHERE id = $1', [id]);
      return rows[0] ? rowToMigration(rows[0]) : null;
    });
  }

  async getPlan(ctx: TenantContext, migrationId: string): Promise<MigrationPlan | null> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT plan_snapshot FROM migrations WHERE id = $1', [
        migrationId,
      ]);
      return rows[0] ? (rows[0].plan_snapshot as MigrationPlan) : null;
    });
  }

  async listMigrations(
    ctx: TenantContext,
    filter: MigrationListFilter,
  ): Promise<MigrationRecord[]> {
    return this.tx(ctx, async (c) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.state) {
        params.push(filter.state);
        clauses.push(`state = $${params.length}`);
      }
      if (filter.batchId) {
        params.push(filter.batchId);
        clauses.push(`batch_id = $${params.length}`);
      }
      if (filter.blockedOnly) {
        clauses.push('blocking_exception_count > 0');
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(filter.limit ?? 50);
      params.push(filter.offset ?? 0);
      const { rows } = await c.query(
        `SELECT * FROM migrations ${where}
         ORDER BY created_at, id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return rows.map(rowToMigration);
    });
  }

  async updateMigration(
    ctx: TenantContext,
    id: string,
    patch: Partial<
      Pick<MigrationRecord, 'state' | 'completion' | 'blockingExceptionCount' | 'completedAt'>
    >,
  ): Promise<MigrationRecord> {
    return this.tx(ctx, async (c) => {
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [];
      if (patch.state !== undefined) {
        params.push(patch.state);
        sets.push(`state = $${params.length}`);
      }
      if (patch.completion !== undefined) {
        params.push(patch.completion);
        sets.push(`completion = $${params.length}`);
      }
      if (patch.blockingExceptionCount !== undefined) {
        params.push(patch.blockingExceptionCount);
        sets.push(`blocking_exception_count = $${params.length}`);
      }
      if (patch.completedAt !== undefined) {
        params.push(patch.completedAt);
        sets.push(`completed_at = $${params.length}`);
      }
      params.push(id);
      const { rows } = await c.query(
        `UPDATE migrations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!rows[0]) throw new Error(`migration ${id} not found`);
      return rowToMigration(rows[0]);
    });
  }

  // -- tasks and exceptions -------------------------------------------------------

  async listTasks(ctx: TenantContext, migrationId: string): Promise<MigrationTask[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM migration_tasks WHERE migration_id = $1 ORDER BY position',
        [migrationId],
      );
      return rows.map(rowToTask);
    });
  }

  async updateTask(ctx: TenantContext, task: MigrationTask): Promise<void> {
    await this.tx(ctx, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE migration_tasks SET
           status = $2,
           started_at = CASE WHEN $2 IN ('IN_PROGRESS','WAITING_EXTERNAL','BLOCKED')
                              AND started_at IS NULL THEN now() ELSE started_at END,
           completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END
         WHERE id = $1`,
        [task.id, task.status],
      );
      if (rowCount === 0) throw new Error(`task ${task.id} not found`);
    });
  }

  async listExceptions(
    ctx: TenantContext,
    opts: { migrationId?: string; openOnly?: boolean },
  ): Promise<(MigrationException & { migrationId: string; resolvedAt: string | null })[]> {
    return this.tx(ctx, async (c) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.migrationId) {
        params.push(opts.migrationId);
        clauses.push(`migration_id = $${params.length}`);
      }
      if (opts.openOnly) {
        clauses.push('resolved_at IS NULL');
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await c.query(
        `SELECT * FROM migration_exceptions ${where} ORDER BY created_at`,
        params,
      );
      return rows.map(rowToException);
    });
  }

  async putException(
    ctx: TenantContext,
    migrationId: string,
    exception: MigrationException,
  ): Promise<void> {
    await this.tx(ctx, async (c) => {
      await c.query(
        `INSERT INTO migration_exceptions
           (id, tenant_id, migration_id, code, severity, message, resolution, subject_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code, severity = EXCLUDED.severity, message = EXCLUDED.message,
           resolution = EXCLUDED.resolution, subject_id = EXCLUDED.subject_id`,
        [
          exception.id,
          ctx.tenantId,
          migrationId,
          exception.code,
          exception.severity,
          exception.message,
          exception.resolution,
          exception.subjectId,
        ],
      );
    });
  }

  async resolveException(
    ctx: TenantContext,
    exceptionId: string,
    by: string,
    note: string,
  ): Promise<void> {
    await this.tx(ctx, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE migration_exceptions
         SET resolved_at = now(), resolved_by = $2, resolution_note = $3
         WHERE id = $1`,
        [exceptionId, by, note],
      );
      if (rowCount === 0) throw new Error(`exception ${exceptionId} not found`);
    });
  }

  // -- events -----------------------------------------------------------------

  async appendEvents(ctx: TenantContext, events: MigrationEvent[]): Promise<void> {
    if (events.length === 0) return;
    const COLS = 6;
    await this.tx(ctx, async (c) => {
      const params: unknown[] = [];
      for (const event of events) {
        params.push(
          ctx.tenantId,
          event.migrationId,
          event.sequence,
          event.type,
          JSON.stringify(event.payload),
          event.occurredAt,
        );
      }
      // One statement for the whole batch, still inside the caller's
      // transaction: a duplicate sequence anywhere in it rolls the lot back,
      // same as the per-row loop this replaced (this.tx already wraps every
      // call in BEGIN/COMMIT/ROLLBACK).
      await c.query(
        `INSERT INTO migration_events (tenant_id, migration_id, sequence, type, payload, occurred_at)
         VALUES ${valuesPlaceholders(events.length, COLS)}`,
        params,
      );
    });
  }

  async listEvents(ctx: TenantContext, migrationId: string): Promise<MigrationEvent[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM migration_events WHERE migration_id = $1 ORDER BY sequence',
        [migrationId],
      );
      return rows.map((r) => ({
        sequence: r.sequence,
        migrationId: r.migration_id,
        tenantId: r.tenant_id,
        type: r.type,
        occurredAt: isoOf(r.occurred_at),
        payload: r.payload,
      }));
    });
  }

  // -- webhooks -----------------------------------------------------------------

  async putWebhookEndpoint(ctx: TenantContext, endpoint: WebhookEndpoint): Promise<void> {
    await this.tx(ctx, async (c) => {
      await c.query(
        `INSERT INTO webhook_endpoints (id, tenant_id, url, secret, event_types, active)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           url = EXCLUDED.url, secret = EXCLUDED.secret, event_types = EXCLUDED.event_types,
           active = EXCLUDED.active`,
        [endpoint.id, ctx.tenantId, endpoint.url, endpoint.secret, endpoint.eventTypes, endpoint.active],
      );
    });
  }

  async listWebhookEndpoints(ctx: TenantContext): Promise<WebhookEndpoint[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM webhook_endpoints WHERE active ORDER BY created_at',
      );
      return rows.map(rowToEndpoint);
    });
  }

  async enqueueDelivery(ctx: TenantContext, delivery: WebhookDelivery): Promise<void> {
    await this.tx(ctx, async (c) => {
      await c.query(
        `INSERT INTO webhook_deliveries
           (id, tenant_id, endpoint_id, event_type, payload, status, attempts,
            next_attempt_at, last_status_code, last_error, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          delivery.id,
          ctx.tenantId,
          delivery.endpointId,
          delivery.eventType,
          JSON.stringify(delivery.payload),
          delivery.status,
          delivery.attempts,
          delivery.nextAttemptAt,
          delivery.lastStatusCode,
          delivery.lastError,
          delivery.deliveredAt,
        ],
      );
    });
  }

  /** Cross-tenant by contract — see the class doc and db/migrations/0003. */
  async listDueDeliveries(now: string, limit: number): Promise<WebhookDelivery[]> {
    return this.workerTx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         ORDER BY next_attempt_at NULLS FIRST
         LIMIT $2`,
        [now, limit],
      );
      return rows.map(rowToDelivery);
    });
  }

  async updateDelivery(delivery: WebhookDelivery): Promise<void> {
    await this.workerTx(async (c) => {
      await c.query(
        `UPDATE webhook_deliveries SET
           status = $2, attempts = $3, next_attempt_at = $4, last_status_code = $5,
           last_error = $6, delivered_at = $7
         WHERE id = $1`,
        [
          delivery.id,
          delivery.status,
          delivery.attempts,
          delivery.nextAttemptAt,
          delivery.lastStatusCode,
          delivery.lastError,
          delivery.deliveredAt,
        ],
      );
    });
  }

  async listDeliveries(
    ctx: TenantContext,
    opts: { status?: DeliveryStatus; limit?: number },
  ): Promise<WebhookDelivery[]> {
    return this.tx(ctx, async (c) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.status) {
        params.push(opts.status);
        clauses.push(`status = $${params.length}`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(opts.limit ?? 100);
      const { rows } = await c.query(
        `SELECT * FROM webhook_deliveries ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToDelivery);
    });
  }

  // -- batches ------------------------------------------------------------------

  async createBatch(ctx: TenantContext, batch: BatchRecord): Promise<void> {
    await this.tx(ctx, async (c) => {
      await c.query(
        `INSERT INTO migration_batches
           (id, tenant_id, name, origin_institution_id, destination_institution_id, status,
            total_customers, planned_count, failed_count, blocked_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          batch.id,
          ctx.tenantId,
          batch.name,
          batch.originInstitutionId,
          batch.destinationInstitutionId,
          batch.status,
          batch.totalCustomers,
          batch.plannedCount,
          batch.failedCount,
          batch.blockedCount,
        ],
      );
    });
  }

  async getBatch(ctx: TenantContext, id: string): Promise<BatchRecord | null> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT * FROM migration_batches WHERE id = $1', [id]);
      return rows[0] ? rowToBatch(rows[0]) : null;
    });
  }

  async updateBatch(
    ctx: TenantContext,
    id: string,
    patch: Partial<BatchRecord>,
  ): Promise<BatchRecord> {
    return this.tx(ctx, async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const col: Record<string, string> = {
        status: 'status',
        totalCustomers: 'total_customers',
        plannedCount: 'planned_count',
        failedCount: 'failed_count',
        blockedCount: 'blocked_count',
        completedAt: 'completed_at',
      };
      for (const [key, column] of Object.entries(col)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value !== undefined) {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        }
      }
      params.push(id);
      const { rows } = await c.query(
        `UPDATE migration_batches SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      if (!rows[0]) throw new Error(`batch ${id} not found`);
      return rowToBatch(rows[0]);
    });
  }

  async listBatches(ctx: TenantContext): Promise<BatchRecord[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query('SELECT * FROM migration_batches ORDER BY created_at DESC');
      return rows.map(rowToBatch);
    });
  }

  // -- audit and analytics -------------------------------------------------------

  async audit(entry: AuditEntry): Promise<void> {
    await this.tx({ tenantId: entry.tenantId }, async (c) => {
      // A denied request is audited under whatever tenant id the caller
      // claimed — including a forged key or the 'unknown' sentinel for a
      // request with no credentials at all (server.ts). `tenants` has no row
      // for that id, and it shouldn't need one: a security log must never
      // fail to write because the attacker's claimed identity doesn't exist.
      // `InMemoryStore.audit` has no FK to violate in the first place; this
      // is that same permissiveness, made explicit for the one table where
      // referential integrity would otherwise get in the way of its purpose.
      await this.ensureTenant(c, entry.tenantId);
      await c.query(
        `INSERT INTO audit_log
           (tenant_id, api_key_id, actor_role, action, resource_type, resource_id, outcome, detail, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          entry.tenantId,
          entry.apiKeyId ?? null,
          entry.actorRole ?? null,
          entry.action,
          entry.resourceType,
          entry.resourceId ?? null,
          entry.outcome,
          JSON.stringify(entry.detail ?? {}),
          entry.occurredAt,
        ],
      );
    });
  }

  async listAudit(ctx: TenantContext, limit: number): Promise<AuditEntry[]> {
    return this.tx(ctx, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT $1',
        [limit],
      );
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        apiKeyId: r.api_key_id ?? undefined,
        actorRole: r.actor_role ?? undefined,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id ?? undefined,
        outcome: r.outcome,
        detail: r.detail,
        occurredAt: isoOf(r.occurred_at),
      }));
    });
  }

  async portfolioStats(ctx: TenantContext): Promise<PortfolioStats> {
    return this.tx(ctx, async (c) => {
      const { rows: stateRows } = await c.query(
        'SELECT state, count(*)::int AS n FROM migrations GROUP BY state',
      );
      const byState: Record<string, number> = {};
      let total = 0;
      for (const r of stateRows) {
        byState[r.state] = r.n;
        total += r.n;
      }

      const { rows: aggRows } = await c.query(
        `SELECT
           count(*) FILTER (WHERE state = 'COMPLETED')::int AS completed,
           count(*) FILTER (WHERE state NOT IN ('COMPLETED','CANCELLED','CREATED'))::int AS in_progress,
           count(*) FILTER (WHERE blocking_exception_count > 0)::int AS blocked,
           coalesce(avg(completion), 0)::float8 AS avg_completion
         FROM migrations`,
      );
      const agg = aggRows[0];

      const { rows: reasonRows } = await c.query(
        `SELECT code, count(*)::int AS n FROM migration_exceptions
         WHERE resolved_at IS NULL GROUP BY code ORDER BY n DESC, code`,
      );
      const totalExceptions = reasonRows.reduce((s, r) => s + r.n, 0);

      return {
        total,
        byState,
        completed: agg.completed,
        inProgress: agg.in_progress,
        blocked: agg.blocked,
        averageCompletion: agg.avg_completion,
        failureReasons: reasonRows.map((r) => ({
          code: r.code,
          count: r.n,
          share: totalExceptions === 0 ? 0 : r.n / totalExceptions,
        })),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToInstitution(r: Record<string, unknown>): Institution {
  return {
    id: r.id as string,
    name: r.name as string,
    country: r.country as Institution['country'],
    type: r.type as Institution['type'],
    bic: (r.bic as string | null) ?? undefined,
    capabilities: {
      supportedProducts: r.supported_products as Institution['capabilities']['supportedProducts'],
      supportsBankMobilityScheme: r.supports_mobility_scheme as boolean,
      supportsSecuritiesTransferIn: r.supports_securities_in as boolean,
      hasApi: r.has_api as boolean,
    },
  };
}

function rowToCustomer(r: Record<string, unknown>): Customer {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    institutionId: r.institution_id as string,
    identity: {
      firstName: r.first_name as string,
      lastName: r.last_name as string,
      dateOfBirth: r.dob_text as string,
      countryOfResidence: r.country_of_residence as Customer['identity']['countryOfResidence'],
      fiscalResidence: r.fiscal_residence as Customer['identity']['fiscalResidence'],
    },
    consent: {
      id: r.consent_id as string,
      scopes: (r.consent_scopes as Customer['consent']['scopes']) ?? [],
      grantedAt: isoOf(r.consent_granted_at as string | Date),
      expiresAt: isoOf(r.consent_expires_at as string | Date),
      revokedAt: r.consent_revoked_at ? isoOf(r.consent_revoked_at as string | Date) : undefined,
    },
    migrationIds: (r.migration_ids as string[]) ?? [],
  };
}

function rowToProduct(r: Record<string, unknown>): FinancialProduct {
  const metadata = { ...(r.metadata as Record<string, unknown>) };
  const transferable = metadata.transferable as boolean | undefined;
  delete metadata.transferable;
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    customerId: r.customer_id as string,
    institutionId: r.institution_id as string,
    type: r.type as FinancialProduct['type'],
    rawLabel: r.raw_label as string,
    balance: { amount: Number(r.balance_minor), currency: r.currency as FinancialProduct['balance']['currency'] },
    openedAt: r.opened_at_text as string,
    transferable,
    metadata: metadata as FinancialProduct['metadata'],
  };
}

function rowToPayment(r: Record<string, unknown>): RecurringPayment {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    accountId: r.account_id as string,
    merchant: r.merchant as string,
    amount: { amount: Number(r.amount_minor), currency: r.currency as RecurringPayment['amount']['currency'] },
    frequency: r.frequency as RecurringPayment['frequency'],
    category: r.category as RecurringPayment['category'],
    direction: r.direction as RecurringPayment['direction'],
    confidence: Number(r.confidence),
    migrationStatus: r.migration_status as RecurringPayment['migrationStatus'],
  };
}

function rowToMigration(r: Record<string, unknown>): MigrationRecord {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    customerId: r.customer_id as string,
    originInstitutionId: r.origin_institution_id as string,
    destinationInstitutionId: r.destination_institution_id as string,
    batchId: (r.batch_id as string | null) ?? null,
    state: r.state as MigrationRecord['state'],
    completion: Number(r.completion),
    blockingExceptionCount: r.blocking_exception_count as number,
    estimatedDurationDays: r.estimated_duration_days as number,
    estimatedFeesMinor: Number(r.estimated_fees_minor),
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    createdAt: isoOf(r.created_at as string | Date),
    updatedAt: isoOf(r.updated_at as string | Date),
    completedAt: r.completed_at ? isoOf(r.completed_at as string | Date) : null,
  };
}

function rowToTask(r: Record<string, unknown>): MigrationTask {
  return {
    id: r.id as string,
    migrationId: r.migration_id as string,
    itemId: (r.item_id as string | null) ?? null,
    type: r.type as MigrationTask['type'],
    label: r.label as string,
    status: r.status as MigrationTask['status'],
    actor: r.actor as MigrationTask['actor'],
    slaDays: r.sla_days as number,
    dependencies: (r.dependencies as string[]) ?? [],
    documents: (r.documents as MigrationTask['documents']) ?? [],
  };
}

function rowToException(
  r: Record<string, unknown>,
): MigrationException & { migrationId: string; resolvedAt: string | null } {
  return {
    id: r.id as string,
    code: r.code as MigrationException['code'],
    severity: r.severity as MigrationException['severity'],
    message: r.message as string,
    subjectId: (r.subject_id as string | null) ?? null,
    resolution: r.resolution as string,
    migrationId: r.migration_id as string,
    resolvedAt: r.resolved_at ? isoOf(r.resolved_at as string | Date) : null,
  };
}

function rowToEndpoint(r: Record<string, unknown>): WebhookEndpoint {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    url: r.url as string,
    secret: r.secret as string,
    eventTypes: (r.event_types as string[]) ?? [],
    active: r.active as boolean,
    createdAt: isoOf(r.created_at as string | Date),
  };
}

function rowToDelivery(r: Record<string, unknown>): WebhookDelivery {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    endpointId: r.endpoint_id as string,
    eventType: r.event_type as string,
    payload: r.payload as Record<string, unknown>,
    status: r.status as DeliveryStatus,
    attempts: r.attempts as number,
    nextAttemptAt: (r.next_attempt_at as string | null) ? isoOf(r.next_attempt_at as string | Date) : null,
    lastStatusCode: (r.last_status_code as number | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: isoOf(r.created_at as string | Date),
    deliveredAt: r.delivered_at ? isoOf(r.delivered_at as string | Date) : null,
  };
}

function rowToBatch(r: Record<string, unknown>): BatchRecord {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    originInstitutionId: r.origin_institution_id as string,
    destinationInstitutionId: r.destination_institution_id as string,
    status: r.status as BatchRecord['status'],
    totalCustomers: r.total_customers as number,
    plannedCount: r.planned_count as number,
    failedCount: r.failed_count as number,
    blockedCount: r.blocked_count as number,
    createdAt: isoOf(r.created_at as string | Date),
    completedAt: r.completed_at ? isoOf(r.completed_at as string | Date) : null,
  };
}
