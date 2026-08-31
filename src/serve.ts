/**
 * Boot the API with a seeded demo tenant.
 *
 *   npm run serve
 *
 * Prints the tenant's API keys and a dashboard URL. The keys are generated per
 * boot and exist only in this process — restart and they are gone, which is the
 * correct behaviour for something that never persists a credential.
 */

import { wire, seedTenant, buildServer } from './api/bootstrap.js';
import { seedPopulation } from './batch/demo.js';
import { PostgresStore } from './store/postgres.js';
import { createDrainQueue, type DrainQueueHandle } from './webhooks/queue.js';

const PORT = Number(process.env['PORT'] ?? 8080);
const POPULATE = process.argv.includes('--populate');
const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];

const store = DATABASE_URL ? PostgresStore.connect(DATABASE_URL) : undefined;
if (DATABASE_URL) {
  console.log(`Using Postgres store (${new URL(DATABASE_URL).host}). Run "npm run db:migrate" first if this is a fresh database.`);
} else {
  console.log('DATABASE_URL not set — using the in-memory store. Data does not survive a restart.');
}

const w = wire({ store });
const seed = await seedTenant(w);

if (POPULATE) {
  const result = await seedPopulation(w, { tenantId: seed.tenantId, role: 'ADMIN' }, {
    count: Number(process.env['POPULATION'] ?? 120),
    originId: seed.originId,
    destinationId: seed.destinationId,
  });
  console.log(
    `Seeded batch ${result.batchId}: ${result.planned} planned, ${result.blocked} blocked.`,
  );
}

const app = buildServer(w);

// Drain webhook deliveries. REDIS_URL set: a durable BullMQ schedule that
// survives this process restarting (see webhooks/queue.ts). Unset: the
// same setInterval this project always used to stand in for it — still the
// default so `npm run serve` with no other setup stays a demo, not an
// infra checklist.
let drainTimer: NodeJS.Timeout | undefined;
let drainQueue: DrainQueueHandle | undefined;
if (REDIS_URL) {
  console.log(`Using Redis (${new URL(REDIS_URL).host}) for a durable webhook-drain schedule.`);
  drainQueue = createDrainQueue(REDIS_URL, w.webhooks);
} else {
  console.log('REDIS_URL not set — draining webhooks on an in-process timer (see README Milestone 7).');
  drainTimer = setInterval(() => {
    void w.webhooks.drain().catch(() => undefined);
  }, 2_000);
}

const shutdown = async () => {
  if (drainTimer) clearInterval(drainTimer);
  if (drainQueue) await drainQueue.close();
  await app.close();
  if (store) await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: '0.0.0.0' });

const base = `http://localhost:${PORT}`;
console.log(`
Financial Migration OS — API listening on ${base}

  Tenant        ${seed.tenantId}
  Admin key     ${seed.adminKey}
  Read-only key ${seed.readOnlyKey}
  Customer      ${seed.customerId}
  Destination   ${seed.destinationId}

  Dashboard     ${base}/dashboard?key=${seed.readOnlyKey}

Try:
  curl -s ${base}/health
  curl -s -X POST ${base}/v1/migrations \\
    -H "authorization: Bearer ${seed.adminKey}" \\
    -H "content-type: application/json" \\
    -H "idempotency-key: demo-1" \\
    -d '{"customer_id":"${seed.customerId}","destination_institution_id":"${seed.destinationId}"}'
`);
