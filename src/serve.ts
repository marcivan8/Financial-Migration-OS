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

const PORT = Number(process.env['PORT'] ?? 8080);
const POPULATE = process.argv.includes('--populate');

const w = wire();
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

// Drain webhook deliveries on a timer, standing in for the BullMQ worker.
const drainTimer = setInterval(() => {
  void w.webhooks.drain().catch(() => undefined);
}, 2_000);

const shutdown = async () => {
  clearInterval(drainTimer);
  await app.close();
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
