import { randomBytes } from 'node:crypto';
import type { MigrationInput } from '../domain/types.js';
import type { MigrationPlan, MigrationState } from '../domain/migration.js';
import { planMigration } from '../planner/planner.js';
import { Migration } from '../workflow/stateMachine.js';
import { computeCompletion, type CompletionReport } from '../workflow/completion.js';
import type {
  MigrationRecord,
  MigrationStore,
  PreparedMigration,
  TenantContext,
} from '../store/types.js';
import { ConflictError } from '../store/types.js';
import { WebhookDispatcher } from '../webhooks/dispatcher.js';

/**
 * Application service.
 *
 * Holds the one piece of orchestration that does not belong in the pure engine:
 * plan → persist → emit events → publish webhooks → rebuild state on read.
 *
 * The engine stays pure; everything with a side effect happens here, in one
 * place, so it can be tested and audited without a database.
 */

export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(9).toString('hex')}`;

export interface CreateMigrationParams {
  customerId: string;
  destinationInstitutionId: string;
  idempotencyKey?: string;
  batchId?: string;
}

/**
 * Migrations per `store.createMigrations` call in `persistPrepared` — the
 * same bound `BatchPipeline`'s own `IMPORT_CHUNK_SIZE` uses and for the same
 * reason: large enough that a big batch spends its time on the database,
 * small enough to stay well under Postgres' bound-parameter limit even for
 * an unusually document- or task-heavy plan.
 */
const PLAN_CHUNK_SIZE = 200;

export class MigrationService {
  constructor(
    private readonly store: MigrationStore,
    private readonly webhooks: WebhookDispatcher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Validate, plan, and simulate a migration's post-creation task completion
   * in memory, without writing anything. `prepareMigration` and
   * `createMigration` both need exactly this sequence — idempotency check,
   * reads, plan, the CONNECT_ORIGIN/CLASSIFY_PRODUCTS completion the plan
   * implies — and previously each carried its own copy. This is the one
   * implementation both now call, so `planBatch` and `POST /v1/migrations`
   * cannot drift apart on what a freshly planned migration looks like for
   * the same input.
   *
   * What's deliberately NOT shared is what happens after: `createMigration`
   * still calls `persist()` directly against the live `Migration` instance
   * this returns (the same live-instance signature `authorize`,
   * `advanceTask`, `simulate` and `resolveException` all need), while
   * `prepareMigration` snapshots it into a plain `PreparedMigration` for
   * `persistPrepared` to write in a batch later. Merging those two write
   * paths is the risk the original duplication was avoiding, and that
   * tradeoff still stands — only the pure validate/plan/simulate part,
   * which had no reason to differ, is unified here.
   *
   * Returns `existing` when the idempotency key already resolved to a
   * migration — nothing to plan, the caller already has it.
   */
  private async validateAndPlan(
    ctx: TenantContext,
    params: CreateMigrationParams,
  ): Promise<
    | { kind: 'existing'; record: MigrationRecord; plan: MigrationPlan }
    | { kind: 'new'; plan: MigrationPlan; migration: Migration }
  > {
    if (params.idempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(ctx, params.idempotencyKey);
      if (existing) {
        const plan = await this.store.getPlan(ctx, existing.id);
        if (!plan) throw new NotFoundError('plan', existing.id);
        return { kind: 'existing', record: existing, plan };
      }
    }

    const customer = await this.store.getCustomer(ctx, params.customerId);
    if (!customer) throw new NotFoundError('customer', params.customerId);

    const origin = await this.store.getInstitution(ctx, customer.institutionId);
    if (!origin) throw new NotFoundError('institution', customer.institutionId);

    const destination = await this.store.getInstitution(
      ctx,
      params.destinationInstitutionId,
    );
    if (!destination) {
      throw new NotFoundError('institution', params.destinationInstitutionId);
    }

    if (origin.id === destination.id) {
      throw new ValidationError(
        'Origin and destination institutions are the same',
        'destination_institution_id',
      );
    }

    const consentValid =
      !customer.consent.revokedAt &&
      new Date(customer.consent.expiresAt) > this.clock();
    if (!consentValid) {
      throw new ValidationError(
        'Customer consent has expired or been revoked; re-collect consent before planning',
        'consent',
      );
    }

    const products = await this.store.listProducts(ctx, customer.id);
    const recurringPayments = await this.store.listRecurringPayments(ctx, customer.id);

    const input: MigrationInput = {
      tenantId: ctx.tenantId,
      customer,
      origin,
      destination,
      products,
      recurringPayments,
    };

    const migrationId = newId('mig');
    const plan = planMigration(input, { migrationId, now: this.clock() });
    const migration = new Migration(plan, this.clock);

    // Connection and classification are not future work — they happened
    // synchronously while producing this plan. Closing those tasks here keeps
    // the task graph honest: leaving them PENDING would show an operator two
    // outstanding items that nobody will ever action, and would make the
    // customer-authorization task look blocked when it is genuinely next.
    const completeNow = ['CONNECT_ORIGIN', 'CLASSIFY_PRODUCTS'] as const;
    for (const type of completeNow) {
      const task = plan.tasks.find((t) => t.type === type);
      if (!task) continue;
      migration.startTask(task.id);
      migration.completeTask(task.id);
      migration.transitionTo(
        type === 'CONNECT_ORIGIN' ? 'DATA_CONNECTED' : 'ANALYZED',
        type === 'CONNECT_ORIGIN'
          ? 'products supplied with the request'
          : 'products classified by the rules engine',
      );
    }
    migration.transitionTo('PLAN_GENERATED', 'plan generated by the rules engine');

    return { kind: 'new', plan, migration };
  }

  /**
   * `validateAndPlan`, snapshotted into a plain `PreparedMigration` so
   * `BatchPipeline.planBatch` can gather many customers' worth of it —
   * reads run per customer either way, nothing here batches those — before
   * writing any of it through `persistPrepared`.
   */
  async prepareMigration(
    ctx: TenantContext,
    params: CreateMigrationParams,
  ): Promise<
    | { kind: 'existing'; record: MigrationRecord; plan: MigrationPlan }
    | { kind: 'new'; prepared: PreparedMigration }
  > {
    const result = await this.validateAndPlan(ctx, params);
    if (result.kind === 'existing') return result;

    const { plan, migration } = result;
    return {
      kind: 'new',
      prepared: {
        plan,
        tasks: migration.tasks,
        events: [...migration.events],
        exceptions: [...migration.raisedExceptions],
        state: migration.state,
        completion: migration.completionRate(),
        idempotencyKey: params.idempotencyKey,
        batchId: params.batchId,
      },
    };
  }

  /**
   * Persist migrations `prepareMigration` already worked out, in chunks of
   * `PLAN_CHUNK_SIZE` — the write-batching counterpart to `prepareMigration`
   * that gives `BatchPipeline.planBatch` the same tradeoff Milestone 6 gave
   * `importRows`/`importFromProvider`: one transaction and a handful of
   * multi-row `INSERT`s per chunk instead of one transaction (plus a
   * follow-up transaction per task, per event and per raised exception) per
   * migration.
   *
   * A chunk that fails — most likely one row's idempotency key collided
   * with a migration created since `prepareMigration` ran — is retried one
   * migration at a time, the same fallback `persistChunked` uses for
   * imports. A singleton retry that still conflicts is not a hard failure:
   * exactly like `createMigration`'s own conflict handling, it means a
   * concurrent request already created this migration, so the existing
   * record is looked up and reported as a success, not an error.
   */
  async persistPrepared(
    ctx: TenantContext,
    items: { customerId: string; prepared: PreparedMigration }[],
  ): Promise<{ succeeded: Map<string, MigrationRecord>; failed: Map<string, string> }> {
    const succeeded = new Map<string, MigrationRecord>();
    const failed = new Map<string, string>();

    const publish = async (prepared: PreparedMigration) => {
      for (const event of prepared.events) await this.webhooks.publish(ctx, event);
    };

    for (let i = 0; i < items.length; i += PLAN_CHUNK_SIZE) {
      const chunk = items.slice(i, i + PLAN_CHUNK_SIZE);
      try {
        const records = await this.store.createMigrations(
          ctx,
          chunk.map((c) => c.prepared),
        );
        for (let idx = 0; idx < chunk.length; idx++) {
          succeeded.set(chunk[idx]!.customerId, records[idx]!);
        }
        for (const { prepared } of chunk) await publish(prepared);
      } catch {
        for (const { customerId, prepared } of chunk) {
          try {
            const [record] = await this.store.createMigrations(ctx, [prepared]);
            succeeded.set(customerId, record!);
            await publish(prepared);
          } catch (err) {
            if (err instanceof ConflictError && prepared.idempotencyKey) {
              const existing = await this.store.findByIdempotencyKey(
                ctx,
                prepared.idempotencyKey,
              );
              if (existing) {
                succeeded.set(customerId, existing);
                continue;
              }
            }
            failed.set(customerId, err instanceof Error ? err.message : String(err));
          }
        }
      }
    }

    return { succeeded, failed };
  }

  async createMigration(
    ctx: TenantContext,
    params: CreateMigrationParams,
  ): Promise<{ record: MigrationRecord; plan: MigrationPlan; reused: boolean }> {
    // Idempotency first: an institution retrying a timed-out POST must get the
    // migration it already created, not a second one for the same customer.
    const result = await this.validateAndPlan(ctx, params);
    if (result.kind === 'existing') {
      return { record: result.record, plan: result.plan, reused: true };
    }
    const { plan, migration } = result;

    let record: MigrationRecord;
    try {
      record = await this.store.createMigration(ctx, plan, {
        idempotencyKey: params.idempotencyKey,
        batchId: params.batchId,
      });
    } catch (err) {
      // Lost an idempotency race with a concurrent request: return theirs.
      if (err instanceof ConflictError && params.idempotencyKey) {
        const existing = await this.store.findByIdempotencyKey(ctx, params.idempotencyKey);
        const existingPlan = existing ? await this.store.getPlan(ctx, existing.id) : null;
        if (existing && existingPlan) {
          return { record: existing, plan: existingPlan, reused: true };
        }
      }
      throw err;
    }

    await this.persist(ctx, migration, plan);
    const updated = await this.store.updateMigration(ctx, record.id, {
      state: migration.state,
    });

    return { record: updated, plan, reused: false };
  }

  // -------------------------------------------------------------------------
  // Reading — state is rebuilt from the event log, never trusted from a column
  // -------------------------------------------------------------------------

  async rehydrate(ctx: TenantContext, migrationId: string): Promise<Migration> {
    const plan = await this.store.getPlan(ctx, migrationId);
    if (!plan) throw new NotFoundError('migration', migrationId);

    const tasks = await this.store.listTasks(ctx, migrationId);
    const record = await this.store.getMigration(ctx, migrationId);
    if (!record) throw new NotFoundError('migration', migrationId);

    // Restore the plan's task statuses from storage before replaying.
    const planWithStatus: MigrationPlan = {
      ...plan,
      tasks: plan.tasks.map((t) => tasks.find((s) => s.id === t.id) ?? t),
    };

    const events = await this.store.listEvents(ctx, migrationId);
    const lastSequence = events.length === 0 ? 0 : events[events.length - 1]!.sequence;
    const runtimeExceptions = (
      await this.store.listExceptions(ctx, { migrationId })
    ).filter((e) => e.id.includes('.exc_rt')).length;

    const migration = new Migration(planWithStatus, this.clock);
    migration.restore(record.state, planWithStatus.tasks, lastSequence, runtimeExceptions);
    return migration;
  }

  async status(
    ctx: TenantContext,
    migrationId: string,
  ): Promise<{
    record: MigrationRecord;
    state: MigrationState;
    completion: CompletionReport;
    readyTaskIds: string[];
  }> {
    const record = await this.store.getMigration(ctx, migrationId);
    if (!record) throw new NotFoundError('migration', migrationId);
    const plan = await this.store.getPlan(ctx, migrationId);
    if (!plan) throw new NotFoundError('migration', migrationId);

    const migration = await this.rehydrate(ctx, migrationId);
    return {
      record,
      state: migration.state,
      completion: computeCompletion(plan, migration),
      readyTaskIds: migration.ready().map((t) => t.id),
    };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async authorize(ctx: TenantContext, migrationId: string): Promise<MigrationState> {
    const migration = await this.rehydrate(ctx, migrationId);
    const plan = await this.store.getPlan(ctx, migrationId);
    if (!plan) throw new NotFoundError('migration', migrationId);

    const authTask = plan.tasks.find((t) => t.type === 'CUSTOMER_AUTHORIZATION');
    if (!authTask) throw new ValidationError('This plan has no authorization task');

    const current = migration.tasks.find((t) => t.id === authTask.id);
    if (current?.status === 'COMPLETED') {
      // Authorizing twice is a retry, not an error — return the state as it is.
      return migration.state;
    }

    // Authorization cannot be granted out of order: the customer must have had
    // their products connected and classified, and a plan produced, before they
    // can meaningfully consent to it. startTask enforces this and throws if the
    // preconditions are not met, rather than quietly consenting on their behalf.
    migration.startTask(authTask.id);
    migration.completeTask(authTask.id);

    await this.persist(ctx, migration, plan);
    await this.store.updateMigration(ctx, migrationId, { state: migration.state });
    return migration.state;
  }

  async advanceTask(
    ctx: TenantContext,
    migrationId: string,
    taskId: string,
    action: 'start' | 'complete' | 'block',
    detail?: { code?: string; message?: string },
  ): Promise<MigrationState> {
    const migration = await this.rehydrate(ctx, migrationId);
    const plan = await this.store.getPlan(ctx, migrationId);
    if (!plan) throw new NotFoundError('migration', migrationId);
    if (!plan.tasks.some((t) => t.id === taskId)) {
      throw new NotFoundError('task', taskId);
    }

    switch (action) {
      case 'start':
        migration.startTask(taskId);
        break;
      case 'complete': {
        const task = migration.tasks.find((t) => t.id === taskId);
        if (task && task.status !== 'IN_PROGRESS' && task.status !== 'WAITING_EXTERNAL') {
          migration.startTask(taskId);
        }
        migration.completeTask(taskId);
        break;
      }
      case 'block':
        migration.blockTask(
          taskId,
          detail?.code ?? 'MANUAL_REVIEW_REQUIRED',
          detail?.message ?? 'Blocked by operator',
        );
        break;
    }

    await this.persist(ctx, migration, plan);
    await this.refreshBlockedCount(ctx, migrationId);
    const completion = computeCompletion(plan, migration).overall;
    await this.store.updateMigration(ctx, migrationId, {
      state: migration.state,
      completion,
      completedAt: migration.state === 'COMPLETED' ? this.clock().toISOString() : null,
    });
    return migration.state;
  }

  /** Run every remaining task to completion — for demos and sandbox tenants. */
  async simulate(
    ctx: TenantContext,
    migrationId: string,
    blockTaskType?: string,
  ): Promise<MigrationState> {
    const migration = await this.rehydrate(ctx, migrationId);
    const plan = await this.store.getPlan(ctx, migrationId);
    if (!plan) throw new NotFoundError('migration', migrationId);

    let guard = 0;
    while (guard++ < 2000) {
      const ready = migration.ready();
      if (ready.length === 0) break;
      for (const task of ready) {
        migration.startTask(task.id);
        if (blockTaskType && task.type === blockTaskType) {
          migration.blockTask(
            task.id,
            'ORIGIN_UNRESPONSIVE',
            `Simulated: no response from the counterparty on ${task.type}`,
          );
          continue;
        }
        migration.completeTask(task.id);
      }
    }

    if (migration.state === 'VERIFYING') {
      migration.transitionTo('COMPLETED', 'all tasks verified');
    }

    await this.persist(ctx, migration, plan);
    await this.refreshBlockedCount(ctx, migrationId);
    const completion = computeCompletion(plan, migration).overall;
    await this.store.updateMigration(ctx, migrationId, {
      state: migration.state,
      completion,
      completedAt: migration.state === 'COMPLETED' ? this.clock().toISOString() : null,
    });
    return migration.state;
  }

  // -------------------------------------------------------------------------

  /**
   * Persist newly produced events and tasks, then publish the subset the
   * institution subscribed to. Events are written before webhooks fire, so a
   * webhook can never describe something the log does not contain.
   */
  private async persist(
    ctx: TenantContext,
    migration: Migration,
    plan: MigrationPlan,
  ): Promise<void> {
    const stored = await this.store.listEvents(ctx, plan.migrationId);
    const known = new Set(stored.map((e) => e.sequence));
    const fresh = migration.events.filter((e) => !known.has(e.sequence));

    if (fresh.length > 0) {
      await this.store.appendEvents(ctx, fresh);
    }
    for (const task of migration.tasks) {
      await this.store.updateTask(ctx, task);
    }
    // Exceptions raised while executing are rows in the operator's queue, not
    // just entries in the event log. Without this a blocked task left the
    // migration in ACTION_REQUIRED with nothing on the dashboard saying why.
    for (const exception of migration.raisedExceptions) {
      await this.store.putException(ctx, plan.migrationId, exception);
    }
    for (const event of fresh) {
      await this.webhooks.publish(ctx, event);
    }
  }

  /**
   * Recompute the denormalised blocked count from the open exceptions.
   *
   * It is a cached aggregate on `migrations`, kept for dashboard queries over
   * hundreds of thousands of rows. Set once at creation and never refreshed, it
   * drifts in both directions: an operator resolves a case and the portfolio
   * still reports the migration blocked, and a runtime block never shows up at
   * all. Anything that changes the exception set has to come through here.
   */
  private async refreshBlockedCount(
    ctx: TenantContext,
    migrationId: string,
  ): Promise<number> {
    const open = await this.store.listExceptions(ctx, { migrationId, openOnly: true });
    const blocking = open.filter((e) => e.severity === 'BLOCKING').length;
    await this.store.updateMigration(ctx, migrationId, {
      blockingExceptionCount: blocking,
    });
    return blocking;
  }

  /**
   * Resolve an exception and, when it was blocking a task, put that task back
   * in play. Resolving the case without reopening the task would leave the
   * migration permanently stuck with an empty queue — the worst of both.
   */
  async resolveException(
    ctx: TenantContext,
    exceptionId: string,
    by: string,
    note: string,
  ): Promise<{ migrationId: string; state: MigrationState; blockingRemaining: number }> {
    const all = await this.store.listExceptions(ctx, { openOnly: true });
    const exception = all.find((e) => e.id === exceptionId);
    if (!exception) throw new NotFoundError('exception', exceptionId);

    await this.store.resolveException(ctx, exceptionId, by, note);

    const migration = await this.rehydrate(ctx, exception.migrationId);
    const plan = await this.store.getPlan(ctx, exception.migrationId);
    if (!plan) throw new NotFoundError('migration', exception.migrationId);

    // A runtime exception names the task it blocked in its id's sibling: find
    // any blocked task belonging to this exception's subject and reopen it.
    const blocked = migration.tasks.filter((t) => t.status === 'BLOCKED');
    for (const task of blocked) {
      if (exception.subjectId === null || task.itemId === exception.subjectId) {
        migration.clearBlock(task.id, note);
      }
    }

    await this.persist(ctx, migration, plan);
    const blockingRemaining = await this.refreshBlockedCount(ctx, exception.migrationId);
    await this.store.updateMigration(ctx, exception.migrationId, {
      state: migration.state,
    });

    return {
      migrationId: exception.migrationId,
      state: migration.state,
      blockingRemaining,
    };
  }
}
