import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import type { WebhookDispatcher } from './dispatcher.js';

/**
 * The BullMQ half of the swap `dispatcher.ts` already documents: `drain()`'s
 * retry/backoff/dead-letter logic does not move here and does not change —
 * this file only replaces what schedules a sweep and how durably it does
 * it. Everything that decides whether a delivery is retried, backed off, or
 * dead-lettered still lives in `WebhookDispatcher`, exactly as before.
 *
 * What a queue actually buys over `setInterval(() => dispatcher.drain(), ms)`
 * (still `serve.ts`'s default — see below) is durability of the schedule
 * itself: a `setInterval` is gone the moment its process exits, so a crash
 * or a deploy is a silent gap in webhook delivery until something restarts
 * it. `Queue.upsertJobScheduler` persists the repeat schedule in Redis, so
 * the next process to start (this one restarting, or eventually a
 * dedicated worker process) resumes it rather than needing to know it
 * should re-create one — and `upsertJobScheduler` is itself idempotent, so
 * calling it again on every boot is the correct way to "ensure this
 * schedule exists," not a bug waiting to double-schedule.
 */

const QUEUE_NAME = 'fmos-webhook-drain';
const JOB_NAME = 'drain';
/** Stable id for the repeatable schedule — what `upsertJobScheduler` keys its idempotency on. */
const SCHEDULER_ID = 'webhook-drain';

export interface DrainQueueOptions {
  /** How often to sweep for due deliveries, ms. Same default as the old `setInterval`. */
  intervalMs?: number;
  /** Passed straight through to `WebhookDispatcher.drain()`. */
  limit?: number;
  /**
   * BullMQ Worker concurrency — how many `drain()` sweeps this Worker runs
   * at once. Defaults to 1, which is still a perfectly reasonable default at
   * most volumes; raising it is now safe (Milestone 9) because the store's
   * `listDueDeliveries` claims what it selects — `SELECT ... FOR UPDATE SKIP
   * LOCKED` in the same statement that marks a row claimed — so two
   * concurrent sweeps, whether both from this Worker's own concurrency or
   * from a second worker *process* pointed at the same Redis, can no longer
   * both pick the same due delivery. This option exists to make that
   * headroom usable, not to change the default.
   */
  concurrency?: number;
}

export interface DrainQueueHandle {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

/**
 * Wires a durable, restart-safe schedule for `dispatcher.drain()` through
 * BullMQ/Redis. `serve.ts` calls this instead of `setInterval` when
 * `REDIS_URL` is set — the same "only if the infrastructure is configured"
 * pattern `DATABASE_URL` already uses to switch the storage adapter, so a
 * bare `npm run serve` stays a zero-dependency demo.
 *
 * Concurrency defaults to 1 but is a real option now (`DrainQueueOptions`,
 * above) — see there for why raising it, or running a second worker process
 * against the same Redis, is safe as of Milestone 9. Before that milestone
 * this was hard-coded and undocumented-as-a-limit-not-an-oversight; the
 * store's claim step is what changed, not anything in this file's own
 * logic.
 */
export function createDrainQueue(
  redisUrl: string,
  dispatcher: WebhookDispatcher,
  options: DrainQueueOptions = {},
): DrainQueueHandle {
  const intervalMs = options.intervalMs ?? 2_000;
  const limit = options.limit ?? 50;

  // BullMQ's Worker holds a connection open on blocking Redis commands;
  // sharing one IORedis instance between a Queue and a Worker is a
  // documented footgun, so each gets its own.
  const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const queue = new Queue(QUEUE_NAME, { connection: queueConnection });

  const worker = new Worker(
    QUEUE_NAME,
    async () => dispatcher.drain(limit),
    { connection: workerConnection, concurrency: options.concurrency ?? 1 },
  );

  // Registered on every boot; upsertJobScheduler is idempotent on
  // SCHEDULER_ID, so this converges on "the schedule exists" rather than
  // accumulating a new one per restart.
  // `every` already runs the first job immediately (BullMQ warns if you also
  // pass `immediately: true` alongside it — redundant, not additive).
  void queue.upsertJobScheduler(SCHEDULER_ID, { every: intervalMs }, { name: JOB_NAME });

  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
      await queueConnection.quit();
      await workerConnection.quit();
    },
  };
}
