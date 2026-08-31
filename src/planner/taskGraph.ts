import type { MigrationTask, TaskType, TaskActor } from '../domain/migration.js';

/**
 * Task graph utilities.
 *
 * The dependency graph is the difference between an orchestration product and
 * a checklist. "Close the old Livret A" and "open the new one" are not two
 * ticks on a list — one strictly precedes the other, and getting the order
 * wrong means the customer is briefly holding two of a product they may
 * legally hold only one of.
 */

/** Who is on the hook for each kind of task. */
export const TASK_ACTOR: Record<TaskType, TaskActor> = {
  CONNECT_ORIGIN: 'PLATFORM',
  CLASSIFY_PRODUCTS: 'PLATFORM',
  OPEN_DESTINATION_PRODUCT: 'DESTINATION_INSTITUTION',
  AWAIT_ACCOUNT_CONFIRMATION: 'DESTINATION_INSTITUTION',
  REQUEST_INSTITUTION_TRANSFER: 'DESTINATION_INSTITUTION',
  AWAIT_TRANSFER_SETTLEMENT: 'ORIGIN_INSTITUTION',
  TRANSFER_BALANCE: 'PLATFORM',
  CLOSE_ORIGIN_PRODUCT: 'ORIGIN_INSTITUTION',
  VERIFY_BALANCE: 'PLATFORM',
  COLLECT_DOCUMENT: 'CUSTOMER',
  CUSTOMER_AUTHORIZATION: 'CUSTOMER',
  TRIGGER_MOBILITY_MANDATE: 'DESTINATION_INSTITUTION',
  NOTIFY_PAYMENT_COUNTERPARTY: 'PLATFORM',
  VERIFY_PAYMENT_REDIRECTED: 'PLATFORM',
  MANUAL_REVIEW: 'OPERATIONS',
};

export const TASK_LABEL: Record<TaskType, string> = {
  CONNECT_ORIGIN: 'Connect origin institution',
  CLASSIFY_PRODUCTS: 'Classify detected products',
  OPEN_DESTINATION_PRODUCT: 'Open product at destination',
  AWAIT_ACCOUNT_CONFIRMATION: 'Await destination account confirmation',
  REQUEST_INSTITUTION_TRANSFER: 'Request institution-to-institution transfer',
  AWAIT_TRANSFER_SETTLEMENT: 'Await transfer settlement from origin',
  TRANSFER_BALANCE: 'Transfer balance',
  CLOSE_ORIGIN_PRODUCT: 'Close product at origin',
  VERIFY_BALANCE: 'Verify balance at destination',
  COLLECT_DOCUMENT: 'Collect required document',
  CUSTOMER_AUTHORIZATION: 'Obtain customer authorization',
  TRIGGER_MOBILITY_MANDATE: 'Trigger bank mobility mandate',
  NOTIFY_PAYMENT_COUNTERPARTY: 'Notify payment counterparty of new IBAN',
  VERIFY_PAYMENT_REDIRECTED: 'Verify payment redirected to new account',
  MANUAL_REVIEW: 'Manual review by operations',
};

/** Tasks whose completion depends on a third party answering us. */
export const EXTERNAL_WAIT_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  'AWAIT_ACCOUNT_CONFIRMATION',
  'AWAIT_TRANSFER_SETTLEMENT',
  'CLOSE_ORIGIN_PRODUCT',
]);

/** Rough SLA per task type, in days from the moment it becomes ready. */
export const TASK_SLA_DAYS: Record<TaskType, number> = {
  CONNECT_ORIGIN: 1,
  CLASSIFY_PRODUCTS: 1,
  OPEN_DESTINATION_PRODUCT: 3,
  AWAIT_ACCOUNT_CONFIRMATION: 5,
  REQUEST_INSTITUTION_TRANSFER: 2,
  AWAIT_TRANSFER_SETTLEMENT: 30,
  TRANSFER_BALANCE: 2,
  CLOSE_ORIGIN_PRODUCT: 15,
  VERIFY_BALANCE: 1,
  COLLECT_DOCUMENT: 7,
  CUSTOMER_AUTHORIZATION: 7,
  TRIGGER_MOBILITY_MANDATE: 22,
  NOTIFY_PAYMENT_COUNTERPARTY: 5,
  VERIFY_PAYMENT_REDIRECTED: 10,
  MANUAL_REVIEW: 5,
};

export class CyclicDependencyError extends Error {
  constructor(public readonly remaining: string[]) {
    super(
      `Task graph contains a cycle; could not order: ${remaining.join(', ')}. ` +
        'A migration plan with a dependency cycle is never dispatched.',
    );
    this.name = 'CyclicDependencyError';
  }
}

/**
 * Kahn topological sort, deterministic: ready tasks are drained in stable id
 * order so the same plan always yields the same execution order. Two runs of
 * the planner on the same input must be byte-identical — that is what makes
 * plans diffable and auditable.
 */
export function topologicalOrder(tasks: MigrationTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    const deps = task.dependencies.filter((d) => byId.has(d));
    indegree.set(task.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id)
    .sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    const next = (dependents.get(id) ?? []).slice().sort();
    for (const child of next) {
      const deg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, deg);
      if (deg === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length) {
    const remaining = tasks.map((t) => t.id).filter((id) => !order.includes(id));
    throw new CyclicDependencyError(remaining);
  }
  return order;
}

/**
 * Critical path length in days: the longest chain of SLAs through the graph.
 * This is the honest duration estimate — summing every task's SLA would
 * massively overstate it, since independent branches run in parallel.
 */
export function criticalPathDays(tasks: MigrationTask[], order: string[]): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const finish = new Map<string, number>();
  let longest = 0;

  for (const id of order) {
    const task = byId.get(id);
    if (!task) continue;
    const start = Math.max(
      0,
      ...task.dependencies.map((d) => finish.get(d) ?? 0),
    );
    const end = start + task.slaDays;
    finish.set(id, end);
    if (end > longest) longest = end;
  }
  return longest;
}

/** Tasks that can start right now: every dependency already completed. */
export function readyTasks(tasks: MigrationTask[]): MigrationTask[] {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks.filter(
    (t) =>
      (t.status === 'PENDING' || t.status === 'READY') &&
      t.dependencies.every((d) => status.get(d) === 'COMPLETED' || !status.has(d)),
  );
}
