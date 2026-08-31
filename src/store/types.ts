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
  MigrationState,
  MigrationTask,
} from '../domain/migration.js';

/**
 * The storage port.
 *
 * Every method takes a TenantContext first. This is not a convention that can
 * be forgotten — it is in the type of every call, so a query that could read
 * across institutions does not compile. The Postgres adapter additionally sets
 * `app.tenant_id` per transaction so row-level security enforces the same
 * boundary in the database (db/migrations/0002_rls.sql).
 */

export interface TenantContext {
  tenantId: string;
  apiKeyId?: string;
  role?: ApiRole;
}

export type ApiRole = 'ADMIN' | 'OPERATOR' | 'READ_ONLY' | 'SERVICE';

export class TenantIsolationError extends Error {
  constructor(resource: string, id: string) {
    // Deliberately indistinguishable from "not found": telling a caller that a
    // resource exists but belongs to someone else is itself a leak.
    super(`${resource} ${id} not found`);
    this.name = 'TenantIsolationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface MigrationRecord {
  id: string;
  tenantId: string;
  customerId: string;
  originInstitutionId: string;
  destinationInstitutionId: string;
  batchId: string | null;
  state: MigrationState;
  completion: number;
  blockingExceptionCount: number;
  estimatedDurationDays: number;
  estimatedFeesMinor: number;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MigrationListFilter {
  state?: MigrationState;
  batchId?: string;
  blockedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditEntry {
  tenantId: string;
  apiKeyId?: string;
  actorRole?: ApiRole;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: 'ALLOWED' | 'DENIED';
  detail?: Record<string, unknown>;
  occurredAt: string;
}

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
}

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD_LETTERED';

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type BatchStatus =
  | 'IMPORTING'
  | 'PLANNING'
  | 'PLANNED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED';

export interface BatchRecord {
  id: string;
  tenantId: string;
  name: string;
  originInstitutionId: string;
  destinationInstitutionId: string;
  status: BatchStatus;
  totalCustomers: number;
  plannedCount: number;
  failedCount: number;
  blockedCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface PortfolioStats {
  total: number;
  byState: Record<string, number>;
  completed: number;
  inProgress: number;
  blocked: number;
  averageCompletion: number;
  failureReasons: { code: string; count: number; share: number }[];
}

export interface MigrationStore {
  // -- reference data -------------------------------------------------------
  putInstitution(ctx: TenantContext, institution: Institution): Promise<void>;
  getInstitution(ctx: TenantContext, id: string): Promise<Institution | null>;
  listInstitutions(ctx: TenantContext): Promise<Institution[]>;

  // -- customers ------------------------------------------------------------
  putCustomer(ctx: TenantContext, customer: Customer): Promise<void>;
  getCustomer(ctx: TenantContext, id: string): Promise<Customer | null>;
  putProducts(ctx: TenantContext, products: FinancialProduct[]): Promise<void>;
  listProducts(ctx: TenantContext, customerId: string): Promise<FinancialProduct[]>;
  putRecurringPayments(ctx: TenantContext, payments: RecurringPayment[]): Promise<void>;
  listRecurringPayments(ctx: TenantContext, customerId: string): Promise<RecurringPayment[]>;

  // -- migrations -----------------------------------------------------------
  createMigration(
    ctx: TenantContext,
    plan: MigrationPlan,
    options: { idempotencyKey?: string; batchId?: string },
  ): Promise<MigrationRecord>;
  findByIdempotencyKey(ctx: TenantContext, key: string): Promise<MigrationRecord | null>;
  getMigration(ctx: TenantContext, id: string): Promise<MigrationRecord | null>;
  getPlan(ctx: TenantContext, migrationId: string): Promise<MigrationPlan | null>;
  listMigrations(ctx: TenantContext, filter: MigrationListFilter): Promise<MigrationRecord[]>;
  updateMigration(
    ctx: TenantContext,
    id: string,
    patch: Partial<
      Pick<
        MigrationRecord,
        'state' | 'completion' | 'blockingExceptionCount' | 'completedAt'
      >
    >,
  ): Promise<MigrationRecord>;

  // -- tasks and exceptions -------------------------------------------------
  listTasks(ctx: TenantContext, migrationId: string): Promise<MigrationTask[]>;
  updateTask(ctx: TenantContext, task: MigrationTask): Promise<void>;
  listExceptions(
    ctx: TenantContext,
    opts: { migrationId?: string; openOnly?: boolean },
  ): Promise<(MigrationException & { migrationId: string; resolvedAt: string | null })[]>;
  putException(
    ctx: TenantContext,
    migrationId: string,
    exception: MigrationException,
  ): Promise<void>;
  resolveException(
    ctx: TenantContext,
    exceptionId: string,
    by: string,
    note: string,
  ): Promise<void>;

  // -- events ---------------------------------------------------------------
  appendEvents(ctx: TenantContext, events: MigrationEvent[]): Promise<void>;
  listEvents(ctx: TenantContext, migrationId: string): Promise<MigrationEvent[]>;

  // -- webhooks -------------------------------------------------------------
  putWebhookEndpoint(ctx: TenantContext, endpoint: WebhookEndpoint): Promise<void>;
  listWebhookEndpoints(ctx: TenantContext): Promise<WebhookEndpoint[]>;
  enqueueDelivery(ctx: TenantContext, delivery: WebhookDelivery): Promise<void>;
  listDueDeliveries(now: string, limit: number): Promise<WebhookDelivery[]>;
  updateDelivery(delivery: WebhookDelivery): Promise<void>;
  listDeliveries(
    ctx: TenantContext,
    opts: { status?: DeliveryStatus; limit?: number },
  ): Promise<WebhookDelivery[]>;

  // -- batches --------------------------------------------------------------
  createBatch(ctx: TenantContext, batch: BatchRecord): Promise<void>;
  getBatch(ctx: TenantContext, id: string): Promise<BatchRecord | null>;
  updateBatch(ctx: TenantContext, id: string, patch: Partial<BatchRecord>): Promise<BatchRecord>;
  listBatches(ctx: TenantContext): Promise<BatchRecord[]>;

  // -- audit and analytics --------------------------------------------------
  audit(entry: AuditEntry): Promise<void>;
  listAudit(ctx: TenantContext, limit: number): Promise<AuditEntry[]>;
  portfolioStats(ctx: TenantContext): Promise<PortfolioStats>;
}
