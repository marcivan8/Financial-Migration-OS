import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStore } from '../src/store/memory.js';
import { WebhookDispatcher } from '../src/webhooks/dispatcher.js';
import { createDrainQueue, type DrainQueueHandle } from '../src/webhooks/queue.js';
import type { TenantContext, WebhookDelivery, WebhookEndpoint } from '../src/store/types.js';

/**
 * Requires a real Redis — `createDrainQueue` is a thin wrapper around
 * BullMQ, and the thing worth proving is that it actually drives a real
 * `Worker` against a real Redis-backed schedule, not a mock of BullMQ
 * itself. Skipped, not faked, when `REDIS_URL` isn't set — the same shape
 * as `test/batch.test.ts`'s Postgres-only test for the same reason: some
 * claims can only be checked against the real infrastructure they're about.
 */
const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(!REDIS_URL)('webhook drain queue (Redis/BullMQ)', () => {
  const ctx: TenantContext = { tenantId: 'ten_queue_test' };
  let handle: DrainQueueHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const endpoint: WebhookEndpoint = {
    id: 'whe_1',
    tenantId: ctx.tenantId,
    url: 'https://example.test/hook',
    secret: 'test-secret',
    eventTypes: [],
    active: true,
    createdAt: new Date().toISOString(),
  };

  const pendingDelivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
    id: `whd_${Math.random().toString(16).slice(2)}`,
    tenantId: ctx.tenantId,
    endpointId: endpoint.id,
    eventType: 'migration.created',
    payload: { event: 'migration.created' },
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1_000).toISOString(), // already due
    lastStatusCode: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    ...overrides,
  });

  it('actually drains a due delivery through a real BullMQ worker, not just calls drain() directly', async () => {
    const store = new InMemoryStore();
    await store.putWebhookEndpoint(ctx, endpoint);
    const delivery = pendingDelivery();
    await store.enqueueDelivery(ctx, delivery);

    const posted: string[] = [];
    const dispatcher = new WebhookDispatcher(store, async (url) => {
      posted.push(url);
      return { status: 200 };
    });

    handle = createDrainQueue(REDIS_URL!, dispatcher, { intervalMs: 200, limit: 10 });

    // The worker runs asynchronously against Redis; poll rather than assume
    // a fixed delay is enough (or too much) on a shared CI box.
    const deadline = Date.now() + 5_000;
    let delivered = false;
    while (Date.now() < deadline && !delivered) {
      const rows = await store.listDeliveries(ctx, {});
      delivered = rows.find((d) => d.id === delivery.id)?.status === 'DELIVERED';
      if (!delivered) await new Promise((r) => setTimeout(r, 100));
    }

    expect(delivered).toBe(true);
    expect(posted).toEqual([endpoint.url]);
  }, 10_000);

  it('registers exactly one durable schedule, and re-registering on a "restart" does not duplicate it', async () => {
    const store = new InMemoryStore();
    const dispatcher = new WebhookDispatcher(store);

    handle = createDrainQueue(REDIS_URL!, dispatcher, { intervalMs: 60_000 });
    // Simulate the server restarting and calling createDrainQueue again —
    // upsertJobScheduler must converge, not accumulate a second schedule.
    const second = createDrainQueue(REDIS_URL!, dispatcher, { intervalMs: 60_000 });

    const schedulers = await handle.queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);

    await second.close();
  });

  it('is deliberately single-concurrency — see queue.ts for why', async () => {
    const store = new InMemoryStore();
    const dispatcher = new WebhookDispatcher(store);
    handle = createDrainQueue(REDIS_URL!, dispatcher);
    expect(handle.worker.opts.concurrency).toBe(1);
  });
});
