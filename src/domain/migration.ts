import type { Money, ProductType, RelationshipCategory } from './types.js';

// ---------------------------------------------------------------------------
// Migration state machine
// ---------------------------------------------------------------------------

export type MigrationState =
  | 'CREATED'
  | 'DATA_CONNECTED'
  | 'ANALYZED'
  | 'PLAN_GENERATED'
  | 'CUSTOMER_AUTHORIZED'
  | 'IN_PROGRESS'
  | 'WAITING_EXTERNAL'
  | 'ACTION_REQUIRED'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'CANCELLED';

/**
 * A migration is never one transaction. IN_PROGRESS, WAITING_EXTERNAL and
 * ACTION_REQUIRED form a cycle on purpose: work bounces between "we are doing
 * it", "the other institution owes us an answer" and "a human owes us an
 * answer" many times before verification.
 */
export const ALLOWED_TRANSITIONS: Record<MigrationState, MigrationState[]> = {
  CREATED: ['DATA_CONNECTED', 'CANCELLED'],
  DATA_CONNECTED: ['ANALYZED', 'CANCELLED'],
  ANALYZED: ['PLAN_GENERATED', 'CANCELLED'],
  PLAN_GENERATED: ['CUSTOMER_AUTHORIZED', 'CANCELLED'],
  CUSTOMER_AUTHORIZED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_EXTERNAL', 'ACTION_REQUIRED', 'VERIFYING', 'CANCELLED'],
  WAITING_EXTERNAL: ['IN_PROGRESS', 'ACTION_REQUIRED', 'VERIFYING', 'CANCELLED'],
  ACTION_REQUIRED: ['IN_PROGRESS', 'WAITING_EXTERNAL', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'ACTION_REQUIRED', 'IN_PROGRESS'],
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL_STATES: ReadonlySet<MigrationState> = new Set<MigrationState>([
  'COMPLETED',
  'CANCELLED',
]);

// ---------------------------------------------------------------------------
// Events — the append-only spine of the system
// ---------------------------------------------------------------------------

export type MigrationEventType =
  | 'MigrationCreated'
  | 'DataConnected'
  | 'ProductDetected'
  | 'ProductClassified'
  | 'MigrationPlanCreated'
  | 'CustomerAuthorized'
  | 'TaskStarted'
  | 'TaskCompleted'
  | 'TaskBlocked'
  | 'ExceptionRaised'
  | 'ExceptionResolved'
  | 'TransferRequested'
  | 'TransferStarted'
  | 'TransferCompleted'
  | 'StateChanged'
  | 'MigrationVerified'
  | 'MigrationCompleted';

export interface MigrationEvent {
  /** Monotonic per migration. Gives us replay and a stable audit order. */
  sequence: number;
  migrationId: string;
  tenantId: string;
  type: MigrationEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskActor =
  | 'PLATFORM'
  | 'DESTINATION_INSTITUTION'
  | 'ORIGIN_INSTITUTION'
  | 'CUSTOMER'
  | 'OPERATIONS';

export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'IN_PROGRESS'
  | 'WAITING_EXTERNAL'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'SKIPPED';

export type TaskType =
  | 'CONNECT_ORIGIN'
  | 'CLASSIFY_PRODUCTS'
  | 'OPEN_DESTINATION_PRODUCT'
  | 'AWAIT_ACCOUNT_CONFIRMATION'
  | 'REQUEST_INSTITUTION_TRANSFER'
  | 'AWAIT_TRANSFER_SETTLEMENT'
  | 'TRANSFER_BALANCE'
  | 'CLOSE_ORIGIN_PRODUCT'
  | 'VERIFY_BALANCE'
  | 'COLLECT_DOCUMENT'
  | 'CUSTOMER_AUTHORIZATION'
  | 'TRIGGER_MOBILITY_MANDATE'
  | 'NOTIFY_PAYMENT_COUNTERPARTY'
  | 'VERIFY_PAYMENT_REDIRECTED'
  | 'MANUAL_REVIEW';

export interface MigrationTask {
  id: string;
  migrationId: string;
  /** The plan item this task serves. Null for migration-level tasks. */
  itemId: string | null;
  type: TaskType;
  label: string;
  status: TaskStatus;
  actor: TaskActor;
  /** Days from migration start, used to derive a deadline at execution time. */
  slaDays: number;
  dependencies: string[];
  documents: DocumentRequirement[];
}

export interface DocumentRequirement {
  code: string;
  label: string;
  providedBy: TaskActor;
  mandatory: boolean;
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

/**
 * The exception vocabulary is closed on purpose.
 *
 * It is what the dashboard groups by and what an institution reports on, so a
 * free-text code would fragment the queue into one row per caller's spelling.
 * The API rejects a code outside this list rather than coercing it to something
 * generic — silently rewriting MISSING_DOCUMENT to MANUAL_REVIEW_REQUIRED loses
 * the one fact the operator needed.
 *
 * Planning-time causes (the rules engine raises these):
 */
export type PlanExceptionCode =
  | 'PRODUCT_NOT_SUPPORTED_AT_DESTINATION'
  | 'PRODUCT_NOT_TRANSFERABLE'
  | 'DUPLICATE_REGULATED_PRODUCT'
  | 'MISSING_PRODUCT_METADATA'
  | 'MISSING_CONSENT_SCOPE'
  | 'FISCAL_RESIDENCE_INELIGIBLE'
  | 'DESTINATION_CAPABILITY_MISSING'
  | 'LOW_CONFIDENCE_RECURRING_PAYMENT'
  | 'MANUAL_REVIEW_REQUIRED';

/** Execution-time causes (§14 of the brief — real migrations fail like this): */
export type RuntimeExceptionCode =
  | 'MISSING_DOCUMENT'
  | 'ORIGIN_UNRESPONSIVE'
  | 'DESTINATION_REJECTED'
  | 'INVALID_IBAN'
  | 'CUSTOMER_UNRESPONSIVE'
  | 'CONFLICTING_INFORMATION'
  | 'REGULATORY_RESTRICTION';

export type ExceptionCode = PlanExceptionCode | RuntimeExceptionCode;

/** Codes the API accepts on POST /v1/migrations/:id/actions with block_task. */
export const RUNTIME_EXCEPTION_CODES: readonly ExceptionCode[] = [
  'MISSING_DOCUMENT',
  'ORIGIN_UNRESPONSIVE',
  'DESTINATION_REJECTED',
  'INVALID_IBAN',
  'CUSTOMER_UNRESPONSIVE',
  'CONFLICTING_INFORMATION',
  'REGULATORY_RESTRICTION',
  'MANUAL_REVIEW_REQUIRED',
] as const;

export const isRuntimeExceptionCode = (
  code: string,
): code is RuntimeExceptionCode | 'MANUAL_REVIEW_REQUIRED' =>
  (RUNTIME_EXCEPTION_CODES as readonly string[]).includes(code);

export type ExceptionSeverity = 'INFO' | 'WARNING' | 'BLOCKING';

export interface MigrationException {
  id: string;
  code: ExceptionCode;
  severity: ExceptionSeverity;
  /** Plain-language reason, safe to surface to an operations copilot. */
  message: string;
  /** What the plan item / product this concerns. */
  subjectId: string | null;
  /** What a human must do next. */
  resolution: string;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type MigrationAction =
  | 'AUTOMATED_MOBILITY'
  | 'CLOSE_AND_REOPEN'
  | 'INSTITUTION_TRANSFER'
  | 'KEEP_AT_ORIGIN'
  | 'MANUAL_REVIEW'
  | 'NOT_MIGRATABLE';

export interface MigrationPlanItem {
  id: string;
  subject: 'PRODUCT' | 'RECURRING_PAYMENT';
  subjectId: string;
  productType?: ProductType;
  category: RelationshipCategory;
  label: string;
  action: MigrationAction;
  /** Why this action — the rule id that decided it. Deterministic provenance. */
  ruleId: string;
  rationale: string;
  balance?: Money;
  preservesTaxHistory: boolean;
  estimatedDurationDays: number;
  estimatedFees?: Money;
  taskIds: string[];
  exceptions: MigrationException[];
}

export interface MigrationPlan {
  migrationId: string;
  tenantId: string;
  customerId: string;
  originInstitutionId: string;
  destinationInstitutionId: string;
  generatedAt: string;
  items: MigrationPlanItem[];
  tasks: MigrationTask[];
  /** Topologically ordered task ids — execution order, cycles rejected. */
  executionOrder: string[];
  exceptions: MigrationException[];
  estimatedTotalDurationDays: number;
  estimatedTotalFees: Money;
}
