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
 * In-memory store.
 *
 * Mirrors the Postgres schema's guarantees so tests exercise the same
 * behaviour the database enforces:
 *   - every record carries tenant_id and is filtered on read;
 *   - the event log is append-only with a gapless per-migration sequence;
 *   - idempotency keys are unique per tenant.
 *
 * It is not a toy that "works differently in prod" — the point of writing the
 * schema first is that this adapter has to obey the same rules.
 */

type Row<T> = T & { tenantId: string };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class InMemoryStore implements MigrationStore {
  private institutions = new Map<string, Row<Institution>>();
  private customers = new Map<string, Row<Customer>>();
  private products = new Map<string, Row<FinancialProduct>>();
  private payments = new Map<string, Row<RecurringPayment>>();
  private migrations = new Map<string, MigrationRecord>();
  private plans = new Map<string, Row<{ plan: MigrationPlan }>>();
  private tasks = new Map<string, Row<MigrationTask>>();
  private exceptions = new Map<
    string,
    Row<MigrationException & { migrationId: string; resolvedAt: string | null }>
  >();
  private events: MigrationEvent[] = [];
  private endpoints = new Map<string, WebhookEndpoint>();
  private deliveries = new Map<string, WebhookDelivery>();
  private batches = new Map<string, BatchRecord>();
  private auditEntries: AuditEntry[] = [];

  /** The tenant filter, applied on every read. */
  private mine<T extends { tenantId: string }>(ctx: TenantContext, rows: Iterable<T>): T[] {
    return [...rows].filter((r) => r.tenantId === ctx.tenantId);
  }

  private one<T extends { tenantId: string }>(
    ctx: TenantContext,
    map: Map<string, T>,
    id: string,
  ): T | null {
    const row = map.get(id);
    // A row belonging to another tenant is reported as absent, never as
    // forbidden — "403" would confirm the resource exists.
    if (!row || row.tenantId !== ctx.tenantId) return null;
    return row;
  }

  // -- reference data -------------------------------------------------------

  async putInstitution(ctx: TenantContext, institution: Institution): Promise<void> {
    this.institutions.set(institution.id, { ...clone(institution), tenantId: ctx.tenantId });
  }

  async getInstitution(ctx: TenantContext, id: string): Promise<Institution | null> {
    return this.one(ctx, this.institutions, id);
  }

  async listInstitutions(ctx: TenantContext): Promise<Institution[]> {
    return this.mine(ctx, this.institutions.values());
  }

  // -- customers ------------------------------------------------------------

  async putCustomer(ctx: TenantContext, customer: Customer): Promise<void> {
    this.customers.set(customer.id, { ...clone(customer), tenantId: ctx.tenantId });
  }

  async getCustomer(ctx: TenantContext, id: string): Promise<Customer | null> {
    return this.one(ctx, this.customers, id);
  }

  async putProducts(ctx: TenantContext, products: FinancialProduct[]): Promise<void> {
    for (const p of products) {
      this.products.set(p.id, { ...clone(p), tenantId: ctx.tenantId });
    }
  }

  async listProducts(ctx: TenantContext, customerId: string): Promise<FinancialProduct[]> {
    return this.mine(ctx, this.products.values()).filter((p) => p.customerId === customerId);
  }

  async putRecurringPayments(ctx: TenantContext, payments: RecurringPayment[]): Promise<void> {
    for (const p of payments) {
      this.payments.set(p.id, { ...clone(p), tenantId: ctx.tenantId });
    }
  }

  async listRecurringPayments(
    ctx: TenantContext,
    customerId: string,
  ): Promise<RecurringPayment[]> {
    return this.mine(ctx, this.payments.values()).filter((p) => p.customerId === customerId);
  }

  // -- migrations -----------------------------------------------------------

  async createMigration(
    ctx: TenantContext,
    plan: MigrationPlan,
    options: { idempotencyKey?: string; batchId?: string },
  ): Promise<MigrationRecord> {
    if (options.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(ctx, options.idempotencyKey);
      if (existing) {
        throw new ConflictError(
          `idempotency key already used by migration ${existing.id}`,
        );
      }
    }

    const now = new Date().toISOString();
    const record: MigrationRecord = {
      id: plan.migrationId,
      tenantId: ctx.tenantId,
      customerId: plan.customerId,
      originInstitutionId: plan.originInstitutionId,
      destinationInstitutionId: plan.destinationInstitutionId,
      batchId: options.batchId ?? null,
      state: 'CREATED',
      completion: 0,
      blockingExceptionCount: plan.exceptions.filter((e) => e.severity === 'BLOCKING').length,
      estimatedDurationDays: plan.estimatedTotalDurationDays,
      estimatedFeesMinor: plan.estimatedTotalFees.amount,
      idempotencyKey: options.idempotencyKey ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.migrations.set(record.id, record);
    this.plans.set(record.id, { plan: clone(plan), tenantId: ctx.tenantId });
    for (const task of plan.tasks) {
      this.tasks.set(task.id, { ...clone(task), tenantId: ctx.tenantId });
    }
    for (const exc of plan.exceptions) {
      this.exceptions.set(exc.id, {
        ...clone(exc),
        migrationId: plan.migrationId,
        resolvedAt: null,
        tenantId: ctx.tenantId,
      });
    }
    return record;
  }

  async findByIdempotencyKey(
    ctx: TenantContext,
    key: string,
  ): Promise<MigrationRecord | null> {
    return (
      this.mine(ctx, this.migrations.values()).find((m) => m.idempotencyKey === key) ?? null
    );
  }

  async getMigration(ctx: TenantContext, id: string): Promise<MigrationRecord | null> {
    return this.one(ctx, this.migrations, id);
  }

  async getPlan(ctx: TenantContext, migrationId: string): Promise<MigrationPlan | null> {
    const row = this.one(ctx, this.plans, migrationId);
    return row ? row.plan : null;
  }

  async listMigrations(
    ctx: TenantContext,
    filter: MigrationListFilter,
  ): Promise<MigrationRecord[]> {
    let rows = this.mine(ctx, this.migrations.values());
    if (filter.state) rows = rows.filter((m) => m.state === filter.state);
    if (filter.batchId) rows = rows.filter((m) => m.batchId === filter.batchId);
    if (filter.blockedOnly) rows = rows.filter((m) => m.blockingExceptionCount > 0);
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const offset = filter.offset ?? 0;
    return rows.slice(offset, offset + (filter.limit ?? 50));
  }

  async updateMigration(
    ctx: TenantContext,
    id: string,
    patch: Partial<MigrationRecord>,
  ): Promise<MigrationRecord> {
    const row = this.one(ctx, this.migrations, id);
    if (!row) throw new Error(`migration ${id} not found`);
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.migrations.set(id, next);
    return next;
  }

  // -- tasks and exceptions -------------------------------------------------

  async listTasks(ctx: TenantContext, migrationId: string): Promise<MigrationTask[]> {
    const plan = await this.getPlan(ctx, migrationId);
    if (!plan) return [];
    return plan.executionOrder
      .map((id) => this.one(ctx, this.tasks, id))
      .filter((t): t is Row<MigrationTask> => Boolean(t));
  }

  async updateTask(ctx: TenantContext, task: MigrationTask): Promise<void> {
    const existing = this.one(ctx, this.tasks, task.id);
    if (!existing) throw new Error(`task ${task.id} not found`);
    this.tasks.set(task.id, { ...clone(task), tenantId: ctx.tenantId });
  }

  async listExceptions(
    ctx: TenantContext,
    opts: { migrationId?: string; openOnly?: boolean },
  ): Promise<(MigrationException & { migrationId: string; resolvedAt: string | null })[]> {
    let rows = this.mine(ctx, this.exceptions.values());
    if (opts.migrationId) rows = rows.filter((e) => e.migrationId === opts.migrationId);
    if (opts.openOnly) rows = rows.filter((e) => e.resolvedAt === null);
    return rows;
  }

  async putException(
    ctx: TenantContext,
    migrationId: string,
    exception: MigrationException,
  ): Promise<void> {
    this.exceptions.set(exception.id, {
      ...clone(exception),
      migrationId,
      resolvedAt: null,
      tenantId: ctx.tenantId,
    });
  }

  async resolveException(
    ctx: TenantContext,
    exceptionId: string,
    _by: string,
    _note: string,
  ): Promise<void> {
    const row = this.one(ctx, this.exceptions, exceptionId);
    if (!row) throw new Error(`exception ${exceptionId} not found`);
    row.resolvedAt = new Date().toISOString();
  }

  // -- events ---------------------------------------------------------------

  async appendEvents(ctx: TenantContext, events: MigrationEvent[]): Promise<void> {
    for (const event of events) {
      const duplicate = this.events.some(
        (e) => e.migrationId === event.migrationId && e.sequence === event.sequence,
      );
      if (duplicate) {
        // Mirrors UNIQUE (migration_id, sequence). A repeated sequence means
        // two writers believed they owned the same migration.
        throw new ConflictError(
          `event sequence ${event.sequence} already recorded for ${event.migrationId}`,
        );
      }
      this.events.push({ ...clone(event), tenantId: ctx.tenantId });
    }
  }

  async listEvents(ctx: TenantContext, migrationId: string): Promise<MigrationEvent[]> {
    return this.events
      .filter((e) => e.tenantId === ctx.tenantId && e.migrationId === migrationId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  // -- webhooks -------------------------------------------------------------

  async putWebhookEndpoint(ctx: TenantContext, endpoint: WebhookEndpoint): Promise<void> {
    this.endpoints.set(endpoint.id, { ...clone(endpoint), tenantId: ctx.tenantId });
  }

  async listWebhookEndpoints(ctx: TenantContext): Promise<WebhookEndpoint[]> {
    return this.mine(ctx, this.endpoints.values()).filter((e) => e.active);
  }

  async enqueueDelivery(ctx: TenantContext, delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, { ...clone(delivery), tenantId: ctx.tenantId });
  }

  /** Cross-tenant by design: the delivery worker is infrastructure, not a caller. */
  async listDueDeliveries(now: string, limit: number): Promise<WebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (d) =>
          d.status === 'PENDING' && (d.nextAttemptAt === null || d.nextAttemptAt <= now),
      )
      .sort((a, b) => (a.nextAttemptAt ?? '').localeCompare(b.nextAttemptAt ?? ''))
      .slice(0, limit);
  }

  async updateDelivery(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, clone(delivery));
  }

  async listDeliveries(
    ctx: TenantContext,
    opts: { status?: DeliveryStatus; limit?: number },
  ): Promise<WebhookDelivery[]> {
    let rows = this.mine(ctx, this.deliveries.values());
    if (opts.status) rows = rows.filter((d) => d.status === opts.status);
    return rows.slice(0, opts.limit ?? 100);
  }

  // -- batches --------------------------------------------------------------

  async createBatch(ctx: TenantContext, batch: BatchRecord): Promise<void> {
    this.batches.set(batch.id, { ...clone(batch), tenantId: ctx.tenantId });
  }

  async getBatch(ctx: TenantContext, id: string): Promise<BatchRecord | null> {
    return this.one(ctx, this.batches, id);
  }

  async updateBatch(
    ctx: TenantContext,
    id: string,
    patch: Partial<BatchRecord>,
  ): Promise<BatchRecord> {
    const row = this.one(ctx, this.batches, id);
    if (!row) throw new Error(`batch ${id} not found`);
    const next = { ...row, ...patch };
    this.batches.set(id, next);
    return next;
  }

  async listBatches(ctx: TenantContext): Promise<BatchRecord[]> {
    return this.mine(ctx, this.batches.values());
  }

  // -- audit and analytics --------------------------------------------------

  async audit(entry: AuditEntry): Promise<void> {
    this.auditEntries.push(clone(entry));
  }

  async listAudit(ctx: TenantContext, limit: number): Promise<AuditEntry[]> {
    return this.auditEntries
      .filter((a) => a.tenantId === ctx.tenantId)
      .slice(-limit)
      .reverse();
  }

  async portfolioStats(ctx: TenantContext): Promise<PortfolioStats> {
    const rows = this.mine(ctx, this.migrations.values());
    const byState: Record<string, number> = {};
    for (const m of rows) byState[m.state] = (byState[m.state] ?? 0) + 1;

    const open = this.mine(ctx, this.exceptions.values()).filter((e) => e.resolvedAt === null);
    const counts = new Map<string, number>();
    for (const e of open) counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
    const totalExceptions = open.length;

    const failureReasons = [...counts.entries()]
      .map(([code, count]) => ({
        code,
        count,
        share: totalExceptions === 0 ? 0 : count / totalExceptions,
      }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    return {
      total: rows.length,
      byState,
      completed: rows.filter((m) => m.state === 'COMPLETED').length,
      inProgress: rows.filter(
        (m) => !['COMPLETED', 'CANCELLED', 'CREATED'].includes(m.state),
      ).length,
      blocked: rows.filter((m) => m.blockingExceptionCount > 0).length,
      averageCompletion:
        rows.length === 0
          ? 0
          : rows.reduce((s, m) => s + m.completion, 0) / rows.length,
      failureReasons,
    };
  }
}
