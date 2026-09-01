import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { wire, seedTenant, buildServer, type Wiring } from '../src/api/bootstrap.js';
import type { SeedResult } from '../src/api/bootstrap.js';
import { signPayload, verifySignature } from '../src/webhooks/dispatcher.js';
import { groupExceptions } from '../src/api/dashboard.js';
import { freshStore, closeTestStore, usingPostgres } from './testStore.js';

// Same 36 cases run twice in CI: once against the in-memory adapter (default)
// and once against Postgres when DATABASE_URL is set — see test/testStore.ts.
if (usingPostgres) console.log('api.test.ts running against Postgres (DATABASE_URL set)');

let w: Wiring;
let app: FastifyInstance;
let seed: SeedResult;
let posted: { url: string; body: string; headers: Record<string, string> }[];

beforeEach(async () => {
  posted = [];
  w = wire({
    store: await freshStore(),
    post: async (url, body, headers) => {
      posted.push({ url, body, headers });
      return { status: 200 };
    },
  });
  seed = await seedTenant(w);
  app = buildServer(w);
});

afterAll(async () => {
  await closeTestStore();
});

const auth = (key?: string) => ({ authorization: `Bearer ${key ?? seed.adminKey}` });

const createMigration = async (idem = 'test-1', key?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/migrations',
    headers: { ...auth(key), 'idempotency-key': idem },
    payload: {
      customer_id: seed.customerId,
      destination_institution_id: seed.destinationId,
    },
  });

describe('authentication', () => {
  it('serves health without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a request with no credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/migrations' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects a forged key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/migrations',
      headers: auth('fmos_live_totally_made_up'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const issued = w.keys.issue({ tenantId: seed.tenantId, name: 'temp', role: 'ADMIN' });
    w.keys.revoke(issued.record.id);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/migrations',
      headers: auth(issued.plaintext),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('revoked_credentials');
  });

  it.skipIf(!usingPostgres)(
    "audits a denial under a tenant id nobody issued without tripping audit_log's foreign key",
    async () => {
      // Regression test for bug 6 in the README's "Six bugs the build
      // surfaced": audit_log.tenant_id has a real FK to tenants, and a
      // denied request is audited under whatever tenant id the caller
      // claimed — including a forged key or the "unknown" sentinel for no
      // credentials at all, neither of which has a tenants row. The three
      // denial tests above assert the same 401s but pass trivially against
      // the in-memory store, which has no FK to violate in the first
      // place — this is the one that only means something run against
      // real Postgres, so it stays skipIf(!usingPostgres) rather than
      // silently green with nothing checked, the same way Milestone 6's
      // batch.test.ts guards its own Postgres-only regression.
      const bogusTenantId = `ten_never_seeded_${Math.random().toString(16).slice(2)}`;
      await expect(
        w.store.audit({
          tenantId: bogusTenantId,
          action: 'migration.list',
          resourceType: 'migration',
          outcome: 'DENIED',
          occurredAt: new Date().toISOString(),
        }),
      ).resolves.not.toThrow();

      const entries = await w.store.listAudit({ tenantId: bogusTenantId }, 10);
      expect(entries.some((e) => e.outcome === 'DENIED')).toBe(true);
    },
  );

  it('never stores the plaintext key', () => {
    const issued = w.keys.issue({ tenantId: seed.tenantId, name: 'x', role: 'ADMIN' });
    expect(issued.record).not.toHaveProperty('plaintext');
    expect(JSON.stringify(issued.record)).not.toContain(issued.plaintext);
    // The prefix is enough to identify the key in a log, not to use it.
    expect(issued.plaintext.startsWith(issued.record.prefix)).toBe(true);
  });
});

describe('RBAC', () => {
  it('lets a read-only key read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/migrations',
      headers: auth(seed.readOnlyKey),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to let a read-only key create a migration', async () => {
    const res = await createMigration('rbac-1', seed.readOnlyKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('insufficient_scope');
  });

  it('refuses to let a SERVICE key resolve a compliance exception', async () => {
    const svc = w.keys.issue({ tenantId: seed.tenantId, name: 'svc', role: 'SERVICE' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/exceptions/exc_0001/resolve',
      headers: auth(svc.plaintext),
      payload: { note: 'looks fine' },
    });
    // Clearing a block is a human judgement with a name on it, not a machine action.
    expect(res.statusCode).toBe(403);
  });

  it('records both allowed and denied calls in the audit log', async () => {
    await createMigration('audit-1');
    await createMigration('audit-2', seed.readOnlyKey);
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: auth() });
    const outcomes = res.json().data.map((a: { outcome: string }) => a.outcome);
    expect(outcomes).toContain('ALLOWED');
    expect(outcomes).toContain('DENIED');
  });
});

describe('tenant isolation', () => {
  it('hides another tenant\'s migration behind a 404, not a 403', async () => {
    const created = await createMigration('iso-1');
    const migrationId = created.json().id;

    const other = w.keys.issue({ tenantId: 'ten_other', name: 'other', role: 'ADMIN' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/migrations/${migrationId}`,
      headers: auth(other.plaintext),
    });
    // 403 would confirm the resource exists. It must be indistinguishable
    // from a migration that was never created.
    expect(res.statusCode).toBe(404);
  });

  it('does not list another tenant\'s migrations', async () => {
    await createMigration('iso-2');
    const other = w.keys.issue({ tenantId: 'ten_other', name: 'other', role: 'ADMIN' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/migrations',
      headers: auth(other.plaintext),
    });
    expect(res.json().count).toBe(0);
  });

  it('does not leak another tenant\'s customer into a plan', async () => {
    const other = w.keys.issue({ tenantId: 'ten_other', name: 'other', role: 'ADMIN' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/migrations',
      headers: auth(other.plaintext),
      payload: {
        customer_id: seed.customerId,
        destination_institution_id: seed.destinationId,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('migration lifecycle', () => {
  it('creates a migration with a full plan', async () => {
    const res = await createMigration('life-1');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.state).toBe('PLAN_GENERATED');
    expect(body.plan.items.length).toBeGreaterThan(10);
    expect(body.plan.dispatchable).toBe(false); // the fixture LEP is blocking
    expect(body.plan.items[0].rule_id).toBeTruthy();
  });

  it('replays an idempotent create instead of duplicating it', async () => {
    const first = await createMigration('same-key');
    const second = await createMigration('same-key');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);

    const list = await app.inject({ method: 'GET', url: '/v1/migrations', headers: auth() });
    expect(list.json().count).toBe(1);
  });

  it('exposes products, tasks, documents and events', async () => {
    const id = (await createMigration('life-2')).json().id;
    for (const path of ['products', 'tasks', 'documents', 'events']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/migrations/${id}/${path}`,
        headers: auth(),
      });
      expect(res.statusCode, path).toBe(200);
      expect(Array.isArray(res.json().data), path).toBe(true);
    }
  });

  it('authorizes, then runs to completion', async () => {
    const id = (await createMigration('life-3')).json().id;

    const authorized = await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/authorize`,
      headers: auth(),
    });
    expect(authorized.json().state).toBe('CUSTOMER_AUTHORIZED');

    const simulated = await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: { action: 'simulate' },
    });
    expect(simulated.json().state).toBe('COMPLETED');

    const status = await app.inject({
      method: 'GET',
      url: `/v1/migrations/${id}/status`,
      headers: auth(),
    });
    expect(status.json().completion.overall).toBeCloseTo(1, 3);
  });

  it('rejects a migration to the institution the customer is already at', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/migrations',
      headers: auth(),
      payload: {
        customer_id: seed.customerId,
        destination_institution_id: seed.originId,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().field).toBe('destination_institution_id');
  });

  it('keeps the event log gapless across separate requests', async () => {
    const id = (await createMigration('life-4')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });
    await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: { action: 'simulate' },
    });

    const events = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/events`, headers: auth() })
    ).json().data as { sequence: number }[];

    expect(events.length).toBeGreaterThan(10);
    // Rehydrating between requests must continue the sequence, not restart it.
    events.forEach((e, i) => expect(e.sequence).toBe(i + 1));
  });
});

describe('webhooks', () => {
  const subscribe = async () =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/webhooks/endpoints',
        headers: auth(),
        payload: { url: 'https://bank.example/hooks' },
      })
    ).json() as { id: string; secret: string };

  it('returns the signing secret exactly once, at creation', async () => {
    const endpoint = await subscribe();
    expect(endpoint.secret).toMatch(/^whsec_/);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/deliveries',
      headers: auth(),
    });
    expect(JSON.stringify(list.json())).not.toContain(endpoint.secret);
  });

  it('queues and delivers only institution-facing events', async () => {
    await subscribe();
    await createMigration('wh-1');
    await w.webhooks.drain();

    const types = posted.map((p) => p.headers['fmos-event-type']);
    expect(types).toContain('migration.created');
    // Internal churn (TaskStarted, StateChanged) must not reach the institution.
    expect(types).not.toContain('task.started');
    expect(types).not.toContain('state.changed');
  });

  it('signs every delivery so the receiver can verify it', async () => {
    const endpoint = await subscribe();
    await createMigration('wh-2');
    await w.webhooks.drain();

    const delivery = posted[0]!;
    const signature = delivery.headers['fmos-signature']!;
    expect(verifySignature(endpoint.secret, delivery.body, signature)).toBe(true);
    expect(verifySignature('whsec_wrong', delivery.body, signature)).toBe(false);
  });

  it('rejects a replayed signature outside the tolerance window', () => {
    const body = '{"event":"migration.completed"}';
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signature = signPayload('whsec_x', body, old);
    expect(verifySignature('whsec_x', body, signature)).toBe(false);
  });

  it('retries a failing endpoint with backoff, then dead-letters it', async () => {
    const failing = wire({ post: async () => ({ status: 500 }) });
    const s = await seedTenant(failing);
    const failingApp = buildServer(failing);
    const a = { authorization: `Bearer ${s.adminKey}` };

    await failingApp.inject({
      method: 'POST',
      url: '/v1/webhooks/endpoints',
      headers: a,
      payload: { url: 'https://down.example/hooks' },
    });
    await failingApp.inject({
      method: 'POST',
      url: '/v1/migrations',
      headers: { ...a, 'idempotency-key': 'wh-3' },
      payload: { customer_id: s.customerId, destination_institution_id: s.destinationId },
    });

    // Each drain covers one attempt; deliveries are scheduled into the future.
    for (let i = 0; i < 8; i++) {
      await failing.store
        .listDueDeliveries(new Date(Date.now() + 86_400_000).toISOString(), 50)
        .then((due) =>
          Promise.all(
            due.map((d) =>
              failing.store.updateDelivery({ ...d, nextAttemptAt: new Date(0).toISOString() }),
            ),
          ),
        );
      await failing.webhooks.drain();
    }

    const dead = await failingApp.inject({
      method: 'GET',
      url: '/v1/webhooks/deliveries?status=DEAD_LETTERED',
      headers: a,
    });
    const rows = dead.json().data as { attempts: number }[];
    expect(rows.length).toBeGreaterThan(0);
    // Dead-lettered, not discarded: the institution can see and replay what it missed.
    expect(rows[0]!.attempts).toBeGreaterThanOrEqual(6);
  });
});

describe('dashboard', () => {
  it('renders live numbers, not a mock', async () => {
    const id = (await createMigration('dash-1')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });

    const res = await app.inject({
      method: 'GET',
      url: `/dashboard?key=${seed.readOnlyKey}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body;
    expect(html).toContain('Migration Operations');
    expect(html).toContain(id);
    expect(html).toContain('PRODUCT_NOT_SUPPORTED_AT_DESTINATION');
  });

  it('refuses to render without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(401);
  });
});

describe('concurrent migrations do not contaminate each other', () => {
  it('keeps task state independent across two migrations', async () => {
    const first = (await createMigration('multi-1')).json().id;
    const second = (await createMigration('multi-2')).json().id;
    expect(first).not.toBe(second);

    // Drive only the first one to completion.
    await app.inject({ method: 'POST', url: `/v1/migrations/${first}/authorize`, headers: auth() });
    await app.inject({
      method: 'POST',
      url: `/v1/migrations/${first}/actions`,
      headers: auth(),
      payload: { action: 'simulate' },
    });

    const firstStatus = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${first}/status`, headers: auth() })
    ).json();
    const secondStatus = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${second}/status`, headers: auth() })
    ).json();

    expect(firstStatus.state).toBe('COMPLETED');
    // The second must be untouched. Shared task ids used to make it report the
    // first one's progress.
    expect(secondStatus.state).toBe('PLAN_GENERATED');
    expect(secondStatus.completion.overall).toBe(0);
  });

  it('authorizes each migration separately', async () => {
    const first = (await createMigration('multi-3')).json().id;
    const second = (await createMigration('multi-4')).json().id;

    const a1 = await app.inject({ method: 'POST', url: `/v1/migrations/${first}/authorize`, headers: auth() });
    expect(a1.json().state).toBe('CUSTOMER_AUTHORIZED');

    // Must not be treated as already-authorized because it shares task ids.
    const a2 = await app.inject({ method: 'POST', url: `/v1/migrations/${second}/authorize`, headers: auth() });
    expect(a2.json().state).toBe('CUSTOMER_AUTHORIZED');
  });

  it('scopes the event log per migration', async () => {
    const first = (await createMigration('multi-5')).json().id;
    const second = (await createMigration('multi-6')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${first}/authorize`, headers: auth() });

    const e1 = (await app.inject({ method: 'GET', url: `/v1/migrations/${first}/events`, headers: auth() })).json().data;
    const e2 = (await app.inject({ method: 'GET', url: `/v1/migrations/${second}/events`, headers: auth() })).json().data;
    expect(e1.length).toBeGreaterThan(e2.length);
  });
});

describe('exception grouping', () => {
  it('collapses one root cause across many customers into a single case', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      migrationId: `mig_${i}`,
      code: 'PRODUCT_NOT_SUPPORTED_AT_DESTINATION' as const,
      severity: 'BLOCKING' as const,
      message: 'Nova Banque does not support LEP.',
      resolution: 'Keep this product at the origin, or confirm the destination now offers it.',
      subjectId: `prd_${i}`,
      resolvedAt: null,
    }));
    const groups = groupExceptions(rows);

    // 40 identical rows is not a queue an operator can work — it is one decision.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.affected).toBe(40);
    expect(groups[0]!.migrationIds.length).toBeLessThanOrEqual(5);
  });

  it('keeps distinct causes apart and puts blocking ones first', () => {
    const groups = groupExceptions([
      {
        id: 'e1', migrationId: 'm1', code: 'LOW_CONFIDENCE_RECURRING_PAYMENT' as const,
        severity: 'WARNING' as const, message: 'x', resolution: 'check it', subjectId: null, resolvedAt: null,
      },
      {
        id: 'e2', migrationId: 'm2', code: 'PRODUCT_NOT_SUPPORTED_AT_DESTINATION' as const,
        severity: 'BLOCKING' as const, message: 'y', resolution: 'decide', subjectId: null, resolvedAt: null,
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.severity).toBe('BLOCKING');
  });
});

describe('partial completion is visible', () => {
  it('does not present a migration that left products behind as plainly complete', async () => {
    const id = (await createMigration('partial-1')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });
    await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: { action: 'simulate' },
    });

    const status = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/status`, headers: auth() })
    ).json();

    // Everything that could move, moved...
    expect(status.state).toBe('COMPLETED');
    expect(status.completion.overall).toBeCloseTo(1, 3);
    // ...but the fixture LEP stayed at the origin, and that must be visible.
    expect(status.completion.excluded.length).toBeGreaterThan(0);
    expect(status.completion.blocking_exceptions).toBeGreaterThan(0);

    const html = (await app.inject({ method: 'GET', url: `/dashboard?key=${seed.readOnlyKey}` })).body;
    expect(html).toContain('COMPLETED · partial');
    expect(html).toContain('Left behind');
  });
});

describe('exception lifecycle (regressions)', () => {
  const firstBlockingId = async () => {
    const rows = (await app.inject({ method: 'GET', url: '/v1/exceptions', headers: auth() })).json()
      .data as { id: string; severity: string }[];
    return rows.find((e) => e.severity === 'BLOCKING')!.id;
  };

  it('a task blocked at runtime reaches the operations queue, not just the event log', async () => {
    const id = (await createMigration('exc-1')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });
    const tasks = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/tasks`, headers: auth() })
    ).json().data as { id: string; type: string }[];
    const target = tasks.find((t) => t.type === 'OPEN_DESTINATION_PRODUCT')!;

    await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: {
        action: 'block_task',
        task_id: target.id,
        code: 'MISSING_DOCUMENT',
        message: 'Customer has not supplied proof of address',
      },
    });

    const open = (await app.inject({ method: 'GET', url: '/v1/exceptions', headers: auth() })).json()
      .data as { code: string; resolution: string }[];
    // Emitting only an event left the migration in ACTION_REQUIRED with nothing
    // in the queue explaining why — the operator could not find it.
    const raised = open.find((e) => e.code === 'MISSING_DOCUMENT');
    expect(raised).toBeDefined();
    expect(raised!.resolution).toContain('destination institution');
  });

  it('preserves the cause instead of flattening it to a generic code', async () => {
    const id = (await createMigration('exc-2')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });
    const tasks = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/tasks`, headers: auth() })
    ).json().data as { id: string; type: string }[];

    await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: {
        action: 'block_task',
        task_id: tasks.find((t) => t.type === 'OPEN_DESTINATION_PRODUCT')!.id,
        code: 'ORIGIN_UNRESPONSIVE',
        message: 'No acknowledgement after 30 days',
      },
    });

    const codes = (
      (await app.inject({ method: 'GET', url: '/v1/exceptions', headers: auth() })).json()
        .data as { code: string }[]
    ).map((e) => e.code);
    expect(codes).toContain('ORIGIN_UNRESPONSIVE');
    expect(codes).not.toContain('MANUAL_REVIEW_REQUIRED');
  });

  it('rejects an invented exception code rather than fragmenting the queue', async () => {
    const id = (await createMigration('exc-3')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });
    const tasks = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/tasks`, headers: auth() })
    ).json().data as { id: string; type: string }[];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: {
        action: 'block_task',
        task_id: tasks.find((t) => t.type === 'OPEN_DESTINATION_PRODUCT')!.id,
        code: 'the_bank_was_being_weird',
        message: 'x',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().field).toBe('code');
  });

  it('clears the blocked count when an operator resolves the case', async () => {
    const id = (await createMigration('exc-4')).json().id;
    const before = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}`, headers: auth() })
    ).json();
    expect(before.blocking_exceptions).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/exceptions/${await firstBlockingId()}/resolve`,
      headers: auth(),
      payload: { note: 'LEP stays at the origin; customer informed' },
    });
    expect(res.json().blocking_remaining).toBe(0);

    // The cached count on `migrations` is what the portfolio view reads. Left
    // stale, the dashboard reports a migration blocked forever after the case
    // has been closed.
    const after = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}`, headers: auth() })
    ).json();
    expect(after.blocking_exceptions).toBe(0);

    const stats = (
      await app.inject({ method: 'GET', url: '/v1/portfolio/stats', headers: auth() })
    ).json();
    expect(stats.blocked).toBe(0);
  });

  it('reopens the task a resolved exception was blocking', async () => {
    const id = (await createMigration('exc-5')).json().id;
    await app.inject({ method: 'POST', url: `/v1/migrations/${id}/authorize`, headers: auth() });
    const tasks = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/tasks`, headers: auth() })
    ).json().data as { id: string; type: string; itemId: string | null }[];
    const target = tasks.find((t) => t.type === 'OPEN_DESTINATION_PRODUCT')!;

    await app.inject({
      method: 'POST',
      url: `/v1/migrations/${id}/actions`,
      headers: auth(),
      payload: { action: 'block_task', task_id: target.id, code: 'MISSING_DOCUMENT', message: 'x' },
    });

    const open = (await app.inject({ method: 'GET', url: '/v1/exceptions', headers: auth() })).json()
      .data as { id: string; code: string }[];
    const runtime = open.find((e) => e.code === 'MISSING_DOCUMENT')!;

    await app.inject({
      method: 'POST',
      url: `/v1/exceptions/${runtime.id}/resolve`,
      headers: auth(),
      payload: { note: 'document received' },
    });

    const after = (
      await app.inject({ method: 'GET', url: `/v1/migrations/${id}/tasks`, headers: auth() })
    ).json().data as { id: string; status: string }[];
    // Closing the case without reopening the task is the worst of both: an
    // empty queue and a migration that can never move.
    expect(after.find((t) => t.id === target.id)!.status).not.toBe('BLOCKED');
  });
});
