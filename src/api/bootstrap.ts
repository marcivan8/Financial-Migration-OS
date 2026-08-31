import { InMemoryStore } from '../store/memory.js';
import { ApiKeyRegistry } from '../auth/keys.js';
import { WebhookDispatcher, type HttpPoster } from '../webhooks/dispatcher.js';
import { MigrationService } from './service.js';
import { BatchPipeline } from '../batch/pipeline.js';
import { buildServer, type ServerDeps } from './server.js';
import { ORIGIN_BANK, DESTINATION_BANK } from '../fixtures/institutions.js';
import { CUSTOMER, PRODUCTS, RECURRING_PAYMENTS } from '../fixtures/customer.js';
import type { TenantContext } from '../store/types.js';

/**
 * Composition root. Everything that knows how the pieces fit together lives
 * here, so tests can assemble the same graph with a fake HTTP poster and a
 * frozen clock.
 */

export interface Wiring extends ServerDeps {
  store: InMemoryStore;
}

export function wire(options: { post?: HttpPoster; clock?: () => Date } = {}): Wiring {
  const store = new InMemoryStore();
  const keys = new ApiKeyRegistry();
  const clock = options.clock ?? (() => new Date());
  const webhooks = new WebhookDispatcher(store, options.post, clock);
  const service = new MigrationService(store, webhooks, clock);
  const batches = new BatchPipeline(store, service, clock);
  return { store, keys, service, webhooks, batches };
}

export interface SeedResult {
  tenantId: string;
  adminKey: string;
  readOnlyKey: string;
  customerId: string;
  originId: string;
  destinationId: string;
}

/**
 * Seed one tenant with the fixture customer, so a fresh server has something
 * real to show. Returns the plaintext keys — the only moment they exist.
 */
export async function seedTenant(
  w: Wiring,
  tenantId = 'ten_nova',
): Promise<SeedResult> {
  const admin = w.keys.issue({ tenantId, name: 'Seed admin', role: 'ADMIN' });
  const readOnly = w.keys.issue({ tenantId, name: 'Dashboard viewer', role: 'READ_ONLY' });
  const ctx: TenantContext = { tenantId, apiKeyId: admin.record.id, role: 'ADMIN' };

  await w.store.putInstitution(ctx, ORIGIN_BANK);
  await w.store.putInstitution(ctx, DESTINATION_BANK);

  const customer = { ...CUSTOMER, tenantId, institutionId: ORIGIN_BANK.id };
  await w.store.putCustomer(ctx, customer);
  await w.store.putProducts(ctx, PRODUCTS);
  await w.store.putRecurringPayments(ctx, RECURRING_PAYMENTS);

  return {
    tenantId,
    adminKey: admin.plaintext,
    readOnlyKey: readOnly.plaintext,
    customerId: customer.id,
    originId: ORIGIN_BANK.id,
    destinationId: DESTINATION_BANK.id,
  };
}

export { buildServer };
