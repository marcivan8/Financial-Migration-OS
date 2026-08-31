import type {
  MigrationEvent,
  MigrationEventType,
  MigrationPlan,
  MigrationState,
  MigrationTask,
  TaskStatus,
} from '../domain/migration.js';
import { ALLOWED_TRANSITIONS, TERMINAL_STATES } from '../domain/migration.js';
import { EXTERNAL_WAIT_TASKS, readyTasks } from '../planner/taskGraph.js';

/**
 * The migration state machine, backed by an append-only event log.
 *
 * Two properties matter more than anything else here:
 *  1. An illegal transition throws. A migration that "somehow" reached
 *     COMPLETED without going through VERIFYING is a compliance incident.
 *  2. Every state change and task change emits an event. The event log is the
 *     source of truth for audit, replay, analytics and the ops copilot; the
 *     current state is just a fold over it.
 */

export class IllegalTransitionError extends Error {
  constructor(from: MigrationState, to: MigrationState) {
    super(`Illegal migration transition ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export interface MigrationSnapshot {
  migrationId: string;
  tenantId: string;
  state: MigrationState;
  tasks: MigrationTask[];
  events: MigrationEvent[];
}

export class Migration {
  private sequence = 0;
  private _state: MigrationState = 'CREATED';
  private readonly _events: MigrationEvent[] = [];
  private readonly tasksById: Map<string, MigrationTask>;

  constructor(
    private readonly plan: MigrationPlan,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.tasksById = new Map(plan.tasks.map((t) => [t.id, { ...t }]));
    this.record('MigrationCreated', {
      customerId: plan.customerId,
      origin: plan.originInstitutionId,
      destination: plan.destinationInstitutionId,
      itemCount: plan.items.length,
      taskCount: plan.tasks.length,
    });
  }

  get state(): MigrationState {
    return this._state;
  }

  get events(): readonly MigrationEvent[] {
    return this._events;
  }

  get tasks(): MigrationTask[] {
    return this.plan.executionOrder
      .map((id) => this.tasksById.get(id))
      .filter((t): t is MigrationTask => Boolean(t));
  }

  /** Append an event. This is the only way state ever changes. */
  private record(type: MigrationEventType, payload: Record<string, unknown>): MigrationEvent {
    const event: MigrationEvent = {
      sequence: ++this.sequence,
      migrationId: this.plan.migrationId,
      tenantId: this.plan.tenantId,
      type,
      occurredAt: this.clock().toISOString(),
      payload,
    };
    this._events.push(event);
    return event;
  }

  transitionTo(next: MigrationState, reason = ''): void {
    const allowed = ALLOWED_TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new IllegalTransitionError(this._state, next);
    }
    const from = this._state;
    this._state = next;
    this.record('StateChanged', { from, to: next, reason });
    if (next === 'COMPLETED') {
      this.record('MigrationCompleted', { completion: this.completionRate() });
    }
  }

  canTransitionTo(next: MigrationState): boolean {
    return ALLOWED_TRANSITIONS[this._state].includes(next);
  }

  /**
   * Derive the migration state from the task set rather than letting each task
   * handler nudge it ad hoc.
   *
   * The ordering is a priority, not a sequence: one blocked task means the
   * migration needs a human, whatever else is in flight. A migration is only
   * reported as quietly waiting on a third party when nothing is blocked, and
   * only as IN_PROGRESS when nothing is blocked *or* waiting. Without this,
   * "23 tasks progressing, one blocked for three weeks" reads as IN_PROGRESS
   * on the institution's dashboard, which is exactly the failure this product
   * exists to eliminate.
   */
  private reconcileState(reason: string): void {
    if (this.isTerminal) return;
    // Nothing to reconcile until the customer has authorized execution.
    const executing: MigrationState[] = [
      'CUSTOMER_AUTHORIZED',
      'IN_PROGRESS',
      'WAITING_EXTERNAL',
      'ACTION_REQUIRED',
      'VERIFYING',
    ];
    if (!executing.includes(this._state)) return;

    const tasks = this.tasks;

    // Authorization is not execution. A migration stays CUSTOMER_AUTHORIZED
    // until an item-level task actually moves, so an institution's dashboard
    // does not claim work is under way the moment consent is captured — the
    // gap between the two is often days, and it is exactly the gap an
    // operations team needs to see.
    if (this._state === 'CUSTOMER_AUTHORIZED') {
      const executionStarted = tasks.some(
        (t) =>
          t.itemId !== null &&
          (t.status === 'IN_PROGRESS' ||
            t.status === 'WAITING_EXTERNAL' ||
            t.status === 'BLOCKED' ||
            t.status === 'COMPLETED'),
      );
      if (!executionStarted) return;
    }

    const target: MigrationState = tasks.some((t) => t.status === 'BLOCKED')
      ? 'ACTION_REQUIRED'
      : tasks.some((t) => t.status === 'WAITING_EXTERNAL')
        ? 'WAITING_EXTERNAL'
        : tasks.every((t) => t.status === 'COMPLETED' || t.status === 'SKIPPED')
          ? 'VERIFYING'
          : 'IN_PROGRESS';

    if (target === this._state) return;

    if (this.canTransitionTo(target)) {
      this.transitionTo(target, reason);
      return;
    }
    // CUSTOMER_AUTHORIZED and ACTION_REQUIRED both reach the rest of the graph
    // through IN_PROGRESS. Step through it rather than forcing an illegal jump.
    if (this.canTransitionTo('IN_PROGRESS')) {
      this.transitionTo('IN_PROGRESS', reason);
      if (target !== 'IN_PROGRESS' && this.canTransitionTo(target)) {
        this.transitionTo(target, reason);
      }
    }
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this._state);
  }

  // -------------------------------------------------------------------------
  // Task operations
  // -------------------------------------------------------------------------

  private setTaskStatus(taskId: string, status: TaskStatus): MigrationTask {
    const task = this.tasksById.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    task.status = status;
    return task;
  }

  startTask(taskId: string): MigrationTask {
    const task = this.tasksById.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);

    const unmet = task.dependencies.filter(
      (d) => this.tasksById.get(d)?.status !== 'COMPLETED',
    );
    if (unmet.length > 0) {
      throw new Error(
        `Cannot start ${taskId} (${task.type}): unmet dependencies ${unmet.join(', ')}. ` +
          'Executing tasks out of dependency order is how a customer ends up holding two ' +
          'Livrets A, or a closed account with an unsettled balance.',
      );
    }

    const status: TaskStatus = EXTERNAL_WAIT_TASKS.has(task.type)
      ? 'WAITING_EXTERNAL'
      : 'IN_PROGRESS';
    this.setTaskStatus(taskId, status);
    this.record('TaskStarted', { taskId, type: task.type, actor: task.actor, status });
    this.reconcileState(`task ${taskId} started`);
    return task;
  }

  completeTask(taskId: string): MigrationTask {
    const task = this.setTaskStatus(taskId, 'COMPLETED');
    this.record('TaskCompleted', { taskId, type: task.type });

    if (task.type === 'REQUEST_INSTITUTION_TRANSFER') {
      this.record('TransferRequested', { taskId, itemId: task.itemId });
    }
    if (task.type === 'AWAIT_TRANSFER_SETTLEMENT') {
      this.record('TransferCompleted', { taskId, itemId: task.itemId });
    }
    if (task.type === 'CUSTOMER_AUTHORIZATION' && this.canTransitionTo('CUSTOMER_AUTHORIZED')) {
      this.transitionTo('CUSTOMER_AUTHORIZED', 'customer authorization task completed');
      this.record('CustomerAuthorized', { taskId });
    }
    this.reconcileState(`task ${taskId} completed`);
    return task;
  }

  blockTask(taskId: string, exceptionCode: string, message: string): MigrationTask {
    const task = this.setTaskStatus(taskId, 'BLOCKED');
    this.record('TaskBlocked', { taskId, type: task.type });
    this.record('ExceptionRaised', { taskId, code: exceptionCode, message });
    this.reconcileState(`${exceptionCode} on ${taskId}`);
    return task;
  }

  /** Clear a blocked task back to READY once operations has resolved the case. */
  resolveException(taskId: string, note: string): MigrationTask {
    const task = this.setTaskStatus(taskId, 'READY');
    this.record('ExceptionResolved', { taskId, note });
    this.reconcileState(`exception on ${taskId} resolved`);
    return task;
  }

  /** Tasks whose dependencies are all satisfied and which can start now. */
  ready(): MigrationTask[] {
    return readyTasks(this.tasks);
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /**
   * Overall completion, weighted by plan item rather than by task, so that a
   * migration is not reported as 90% done because the easy items had many
   * small tasks.
   */
  completionRate(): number {
    const scores = this.plan.items.map((item) => this.itemCompletion(item.id));
    if (scores.length === 0) return 0;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  itemCompletion(itemId: string): number {
    const item = this.plan.items.find((i) => i.id === itemId);
    if (!item) return 0;

    // An item with nothing to do because it legally cannot move is not a
    // failure of execution, but it is not completion either — it is excluded
    // from the numerator and reported separately.
    if (item.taskIds.length === 0) return 0;

    const done = item.taskIds.filter(
      (id) => this.tasksById.get(id)?.status === 'COMPLETED',
    ).length;
    return done / item.taskIds.length;
  }

  /**
   * Rebuild a migration from storage.
   *
   * The constructor emits MigrationCreated because a genuinely new migration
   * needs that event. On rehydration that event already exists in the log, so
   * restore() drops it and continues the sequence from where storage left off.
   * Without this, every read would mint a duplicate sequence 1 and the
   * UNIQUE (migration_id, sequence) constraint would reject the next write —
   * loudly, which is the correct failure, but it should never get that far.
   */
  restore(state: MigrationState, tasks: MigrationTask[], lastSequence: number): void {
    this._state = state;
    this._events.length = 0;
    this.sequence = lastSequence;
    for (const task of tasks) {
      const existing = this.tasksById.get(task.id);
      if (existing) existing.status = task.status;
    }
  }

  snapshot(): MigrationSnapshot {
    return {
      migrationId: this.plan.migrationId,
      tenantId: this.plan.tenantId,
      state: this._state,
      tasks: this.tasks,
      events: [...this._events],
    };
  }
}
