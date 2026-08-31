import type {
  FinancialProduct,
  MigrationInput,
  Money,
  RecurringPayment,
} from '../domain/types.js';
import { PRODUCT_CATEGORY } from '../domain/types.js';
import type {
  MigrationException,
  MigrationPlan,
  MigrationPlanItem,
  MigrationTask,
  TaskType,
} from '../domain/migration.js';
import {
  resolveProduct,
  detectDuplicateRegulatedProducts,
  resetExceptionIds,
  type RuleContext,
} from '../rules/engine.js';
import {
  TASK_ACTOR,
  TASK_LABEL,
  TASK_SLA_DAYS,
  topologicalOrder,
  criticalPathDays,
} from './taskGraph.js';

/**
 * The migration planner.
 *
 * Input:  customer + origin + destination + products + recurring payments
 * Output: a migration plan — items, a task dependency graph, exceptions and
 *         an honest duration/fee estimate.
 *
 * Pure and deterministic: same input, same plan, every time. Nothing here
 * performs I/O, so a plan can be generated in a test, in a batch job over
 * 500,000 customers, or behind POST /v1/migrations without changing.
 */

/** Confidence below which a detected recurring payment needs a human look. */
export const RECURRING_CONFIDENCE_THRESHOLD = 0.7;

export interface PlannerOptions {
  migrationId: string;
  now?: Date;
  confidenceThreshold?: number;
}

interface IdGen {
  task: () => string;
  item: () => string;
  exception: () => string;
}

/**
 * Ids are namespaced by migration.
 *
 * Task and plan-item ids are primary keys (`migration_tasks.id`,
 * `plan_items.id`). A bare per-plan counter mints `tsk_0001` for every customer
 * in the portfolio: Postgres rejects the second insert, and any store keyed by
 * id silently serves one customer's task statuses as another's — so a migration
 * would report its neighbour's progress, and rehydration would skip work that
 * was never done. Prefixing with the migration id keeps ids unique while
 * staying deterministic, since the migration id is an input to the planner.
 */
function makeIds(migrationId: string): IdGen {
  let t = 0;
  let i = 0;
  let e = 0;
  return {
    task: () => `${migrationId}.tsk_${String(++t).padStart(4, '0')}`,
    item: () => `${migrationId}.itm_${String(++i).padStart(3, '0')}`,
    exception: () => `${migrationId}.exc_p${String(++e).padStart(3, '0')}`,
  };
}

const EUR = (amount: number): Money => ({ amount, currency: 'EUR' });

export function planMigration(
  input: MigrationInput,
  options: PlannerOptions,
): MigrationPlan {
  const { migrationId } = options;
  const now = options.now ?? new Date();
  const threshold = options.confidenceThreshold ?? RECURRING_CONFIDENCE_THRESHOLD;
  const ids = makeIds(migrationId);
  resetExceptionIds();

  const ctx: RuleContext = {
    customer: input.customer,
    origin: input.origin,
    destination: input.destination,
  };

  const items: MigrationPlanItem[] = [];
  const tasks: MigrationTask[] = [];
  const planExceptions: MigrationException[] = [];

  // -------------------------------------------------------------------------
  // Migration-level preamble. Every product task hangs off authorization, so
  // nothing can be dispatched to an institution before the customer has said yes.
  // -------------------------------------------------------------------------
  const connectTask = makeTask(ids.task(), migrationId, null, 'CONNECT_ORIGIN', []);
  const classifyTask = makeTask(ids.task(), migrationId, null, 'CLASSIFY_PRODUCTS', [
    connectTask.id,
  ]);
  const authTask = makeTask(ids.task(), migrationId, null, 'CUSTOMER_AUTHORIZATION', [
    classifyTask.id,
  ]);
  tasks.push(connectTask, classifyTask, authTask);

  // -------------------------------------------------------------------------
  // Cross-product compliance checks, before anything is planned per product.
  // -------------------------------------------------------------------------
  planExceptions.push(
    ...detectDuplicateRegulatedProducts(input.products, input.destination.country),
  );

  // -------------------------------------------------------------------------
  // One plan item per product.
  // -------------------------------------------------------------------------
  const sortedProducts = [...input.products].sort((a, b) => a.id.localeCompare(b.id));

  for (const product of sortedProducts) {
    const decision = resolveProduct(product, ctx);
    const itemId = ids.item();
    const itemTasks: MigrationTask[] = [];

    const template: TaskType[] =
      decision.action === 'NOT_MIGRATABLE'
        ? []
        : decision.action === 'MANUAL_REVIEW'
          ? ['MANUAL_REVIEW']
          : (decision.rule?.taskTemplate ?? []);

    // Chain the template: each step depends on the previous one, and the first
    // depends on customer authorization.
    let previousId: string = authTask.id;
    for (const type of template) {
      const task = makeTask(ids.task(), migrationId, itemId, type, [previousId]);
      task.label = `${TASK_LABEL[type]} — ${product.type}`;
      task.documents = (decision.rule?.documents ?? []).filter(
        (d) => type === 'COLLECT_DOCUMENT' || type === 'OPEN_DESTINATION_PRODUCT',
      );
      itemTasks.push(task);
      previousId = task.id;
    }

    tasks.push(...itemTasks);

    items.push({
      id: itemId,
      subject: 'PRODUCT',
      subjectId: product.id,
      productType: product.type,
      category: PRODUCT_CATEGORY[product.type],
      label: `${product.type} — ${product.rawLabel}`,
      action: decision.action,
      ruleId: decision.ruleId,
      rationale: decision.rationale,
      balance: product.balance,
      preservesTaxHistory: decision.preservesTaxHistory,
      estimatedDurationDays: decision.estimatedDurationDays,
      estimatedFees: decision.estimatedFees,
      taskIds: itemTasks.map((t) => t.id),
      exceptions: decision.exceptions,
    });
  }

  // -------------------------------------------------------------------------
  // Recurring payments.
  //
  // The mobility mandate covers direct debits and standing transfers on the
  // current account, so where it applies we verify rather than notify. Where it
  // does not — or where detection confidence is low — we plan explicit work.
  // -------------------------------------------------------------------------
  const currentAccountItem = items.find(
    (i) => i.productType === 'CURRENT_ACCOUNT' && i.action === 'AUTOMATED_MOBILITY',
  );
  const mobilityTaskId = currentAccountItem
    ? (tasks.find(
        (t) => t.itemId === currentAccountItem.id && t.type === 'TRIGGER_MOBILITY_MANDATE',
      )?.id ?? authTask.id)
    : authTask.id;

  const sortedPayments = [...input.recurringPayments].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  for (const payment of sortedPayments) {
    const itemId = ids.item();
    const covered = Boolean(currentAccountItem);
    const lowConfidence = payment.confidence < threshold;

    const itemExceptions: MigrationException[] = [];
    if (lowConfidence) {
      itemExceptions.push({
        id: ids.exception(),
        code: 'LOW_CONFIDENCE_RECURRING_PAYMENT',
        severity: 'WARNING',
        message: `"${payment.merchant}" detected with confidence ${payment.confidence.toFixed(
          2,
        )}, below the ${threshold} threshold.`,
        subjectId: payment.id,
        resolution:
          'Have an operator confirm this is a genuine recurring relationship before notifying the counterparty.',
      });
    }

    const template: TaskType[] = lowConfidence
      ? ['MANUAL_REVIEW', 'NOTIFY_PAYMENT_COUNTERPARTY', 'VERIFY_PAYMENT_REDIRECTED']
      : covered
        ? ['VERIFY_PAYMENT_REDIRECTED']
        : ['NOTIFY_PAYMENT_COUNTERPARTY', 'VERIFY_PAYMENT_REDIRECTED'];

    const itemTasks: MigrationTask[] = [];
    let previousId = mobilityTaskId;
    for (const type of template) {
      const task = makeTask(ids.task(), migrationId, itemId, type, [previousId]);
      task.label = `${TASK_LABEL[type]} — ${payment.merchant}`;
      itemTasks.push(task);
      previousId = task.id;
    }
    tasks.push(...itemTasks);

    items.push({
      id: itemId,
      subject: 'RECURRING_PAYMENT',
      subjectId: payment.id,
      category: payment.direction === 'INBOUND' ? 'INCOME' : 'DIRECT_DEBITS',
      label: `${payment.merchant} (${payment.category}, ${payment.frequency})`,
      action: covered && !lowConfidence ? 'AUTOMATED_MOBILITY' : 'MANUAL_REVIEW',
      ruleId: covered
        ? 'FR.CURRENT_ACCOUNT.MOBILITY.v1'
        : 'FR.RECURRING_PAYMENT.MANUAL.v1',
      rationale: covered
        ? 'Carried by the statutory mobility mandate; the platform verifies the redirection landed.'
        : 'No mobility mandate in this plan, so the counterparty is notified of the new IBAN directly.',
      balance: payment.amount,
      preservesTaxHistory: false,
      estimatedDurationDays: covered ? 22 : 15,
      taskIds: itemTasks.map((t) => t.id),
      exceptions: itemExceptions,
    });
  }

  // -------------------------------------------------------------------------
  // Ordering, estimates, roll-up.
  // -------------------------------------------------------------------------
  const executionOrder = topologicalOrder(tasks);
  const estimatedTotalDurationDays = criticalPathDays(tasks, executionOrder);

  const estimatedTotalFees = EUR(
    items.reduce((sum, i) => sum + (i.estimatedFees?.amount ?? 0), 0),
  );

  // Namespace every exception id by the migration it belongs to, before the
  // plan leaves this function. The engine's counters are plan-local by design
  // (determinism); uniqueness is this layer's job.
  namespaceExceptionIds(migrationId, planExceptions, items);

  const allExceptions = [
    ...planExceptions,
    ...items.flatMap((i) => i.exceptions),
  ];

  return {
    migrationId,
    tenantId: input.tenantId,
    customerId: input.customer.id,
    originInstitutionId: input.origin.id,
    destinationInstitutionId: input.destination.id,
    generatedAt: now.toISOString(),
    items,
    tasks,
    executionOrder,
    exceptions: allExceptions,
    estimatedTotalDurationDays,
    estimatedTotalFees,
  };
}

/**
 * Rewrite plan-local exception ids (`exc_0001`) into migration-scoped ones
 * (`mig_abc123.exc_0001`). Deterministic — the same input still yields the same
 * plan byte for byte — and unique, because migration ids are.
 */
function namespaceExceptionIds(
  migrationId: string,
  planExceptions: MigrationException[],
  items: MigrationPlanItem[],
): void {
  let n = 0;
  const rename = (e: MigrationException) => {
    e.id = `${migrationId}.exc_${String(++n).padStart(3, '0')}`;
  };
  for (const e of planExceptions) rename(e);
  for (const item of items) for (const e of item.exceptions) rename(e);
}

function makeTask(
  id: string,
  migrationId: string,
  itemId: string | null,
  type: TaskType,
  dependencies: string[],
): MigrationTask {
  return {
    id,
    migrationId,
    itemId,
    type,
    label: TASK_LABEL[type],
    status: dependencies.length === 0 ? 'READY' : 'PENDING',
    actor: TASK_ACTOR[type],
    slaDays: TASK_SLA_DAYS[type],
    dependencies,
    documents: [],
  };
}

/** True when nothing blocking stands between the plan and dispatch. */
export function isPlanDispatchable(plan: MigrationPlan): boolean {
  return !plan.exceptions.some((e) => e.severity === 'BLOCKING');
}
