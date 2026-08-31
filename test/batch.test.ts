import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { wire, seedTenant, type Wiring } from '../src/api/bootstrap.js';
import type { SeedResult } from '../src/api/bootstrap.js';
import type { TenantContext } from '../src/store/types.js';
import type { ImportRow, ProviderImportRow } from '../src/batch/pipeline.js';
import { money } from '../src/domain/types.js';
import { freshStore, closeTestStore, usingPostgres } from './testStore.js';
import { PowensProvider } from '../src/connectivity/powens.js';
import { POWENS_SAMPLE_ACCOUNTS } from '../src/connectivity/fixtures/powens-sample.js';
import { POWENS_SAMPLE_TRANSACTIONS } from '../src/connectivity/fixtures/powens-transactions-sample.js';

let w: Wiring;
let seed: SeedResult;
let ctx: TenantContext;

beforeEach(async () => {
  w = wire({ store: await freshStore(), post: async () => ({ status: 200 }) });
  seed = await seedTenant(w);
  ctx = { tenantId: seed.tenantId, role: 'ADMIN' };
});

afterAll(async () => {
  await closeTestStore();
});

const row = (n: number, overrides: Partial<ImportRow> = {}): ImportRow => ({
  externalRef: `EXT-${n}`,
  firstName: `Client${n}`,
  lastName: 'Dupont',
  dateOfBirth: '1990-01-01',
  products: [
    {
      type: 'CURRENT_ACCOUNT',
      rawLabel: 'Compte de dépôt',
      balance: money(120_00),
      openedAt: '2015-01-01',
      metadata: {},
    },
    {
      type: 'LIVRET_A',
      rawLabel: 'Livret A',
      balance: money(5_000_00),
      openedAt: '2015-01-01',
      metadata: {},
    },
  ],
  recurringPayments: [
    {
      merchant: 'Employeur SA',
      amount: money(2_400_00),
      frequency: 'MONTHLY',
      category: 'SALARY',
      direction: 'INBOUND',
      confidence: 0.98,
      migrationStatus: 'NOT_STARTED',
    },
  ],
  ...overrides,
});

const newBatch = () =>
  w.batches.createBatch(ctx, {
    name: 'Portfolio transfer 2026',
    originInstitutionId: seed.originId,
    destinationInstitutionId: seed.destinationId,
  });

describe('bulk import', () => {
  it('imports a population and reports the count', async () => {
    const batch = await newBatch();
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const result = await w.batches.importRows(ctx, batch.id, rows);

    expect(result.imported).toHaveLength(50);
    expect(result.failures).toHaveLength(0);
    expect((await w.store.getBatch(ctx, batch.id))!.totalCustomers).toBe(50);
  });

  it('records a bad row as a failure and keeps importing the rest', async () => {
    const batch = await newBatch();
    const rows = [row(1), row(2, { products: [] }), row(3)];
    const result = await w.batches.importRows(ctx, batch.id, rows);

    // One malformed record in a 500,000-row file must not abort the run.
    expect(result.imported).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.externalRef).toBe('EXT-2');
    expect(result.failures[0]!.stage).toBe('IMPORT');
  });

  // The test above proves isolation for a row the in-app check already
  // catches (an empty products[]) — it never reaches the database, so it
  // never exercises persistChunked's fallback. This one forces a failure
  // only the database can catch (date_of_birth is a real DATE column, and
  // nothing upstream validates the string is a real date), inside a chunk
  // with otherwise-good rows, to prove the chunk-transaction-fails-so-retry-
  // one-at-a-time path actually isolates the bad row rather than just
  // rejecting the whole chunk. In-memory has no DATE column to reject it, so
  // this only means something against Postgres.
  it.skipIf(!usingPostgres)(
    'isolates a row the database rejects, not just one the app already caught',
    async () => {
      const batch = await newBatch();
      const rows = [row(1), row(2), row(3, { dateOfBirth: 'not-a-real-date' }), row(4), row(5)];
      const result = await w.batches.importRows(ctx, batch.id, rows);

      expect(result.imported).toHaveLength(4);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.externalRef).toBe('EXT-3');
      expect(result.failures[0]!.reason).toMatch(/date/i);
    },
  );
});

describe('provider import (Powens)', () => {
  const providerRow = (n: number, overrides: Partial<ProviderImportRow> = {}): ProviderImportRow => ({
    externalRef: `EXT-${n}`,
    firstName: `Client${n}`,
    lastName: 'Martin',
    dateOfBirth: '1990-01-01',
    rawAccounts: POWENS_SAMPLE_ACCOUNTS,
    ...overrides,
  });

  it('imports a customer from raw provider accounts, normalized on the way in', async () => {
    const batch = await newBatch();
    const result = await w.batches.importFromProvider(ctx, batch.id, PowensProvider, [providerRow(1)]);

    expect(result.imported).toHaveLength(1);
    expect(result.failures).toHaveLength(0);

    const products = await w.store.listProducts(ctx, result.imported[0]!);
    // POWENS_SAMPLE_ACCOUNTS has 9 raw accounts; 6 map to a ProductType (see
    // connectivity.test.ts), the rest are reported skipped below.
    expect(products).toHaveLength(6);
    expect(products.every((p) => p.sourceProvider === 'powens')).toBe(true);
  });

  it('reports unmapped accounts as skipped without failing the customer they belong to', async () => {
    const batch = await newBatch();
    const result = await w.batches.importFromProvider(ctx, batch.id, PowensProvider, [providerRow(1)]);

    expect(result.failures).toHaveLength(0);
    // "savings" (ambiguous), "crowdlending" (out of scope), the deleted
    // livret_a — three of the nine sample accounts, all skipped, none of
    // them turning the whole customer into an import failure.
    expect(result.skippedAccounts).toHaveLength(3);
    expect(result.skippedAccounts.every((s) => s.customerId === result.imported[0])).toBe(true);
    expect(result.skippedAccounts.map((s) => s.rawType).sort()).toEqual(
      ['crowdlending', 'livret_a', 'savings'].sort(),
    );
  });

  it('fails the customer, not just skips, when every account is unusable', async () => {
    const batch = await newBatch();
    const onlyUnmappable = [POWENS_SAMPLE_ACCOUNTS[7]!]; // crowdlending — outside the MVP product set
    const result = await w.batches.importFromProvider(ctx, batch.id, PowensProvider, [
      providerRow(1, { rawAccounts: onlyUnmappable }),
    ]);

    expect(result.imported).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.stage).toBe('IMPORT');
    expect(result.failures[0]!.reason).toMatch(/every account powens returned was unusable/);
  });

  it('keeps importing the rest of the batch after one customer fails', async () => {
    const batch = await newBatch();
    const rows = [
      providerRow(1),
      providerRow(2, { rawAccounts: [POWENS_SAMPLE_ACCOUNTS[7]!] }), // fails: unusable
      providerRow(3),
    ];
    const result = await w.batches.importFromProvider(ctx, batch.id, PowensProvider, rows);

    expect(result.imported).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.externalRef).toBe('EXT-2');
  });
});

describe('recurring-payment detection (Powens)', () => {
  it('detects, persists, and feeds a plan without any further wiring', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importFromProvider(ctx, batch.id, PowensProvider, [
      { externalRef: 'EXT-1', firstName: 'Client1', lastName: 'Martin', dateOfBirth: '1990-01-01', rawAccounts: POWENS_SAMPLE_ACCOUNTS },
    ]);
    const customerId = imported[0]!;

    const result = await w.batches.detectRecurringPayments(ctx, customerId, PowensProvider, {
      '9001': POWENS_SAMPLE_TRANSACTIONS,
    });

    // Three monthly Netflix debits in the fixture, nothing else.
    expect(result.detected).toHaveLength(1);
    expect(result.detected[0]!.merchant).toBe('Netflix');
    expect(result.skippedTransactions).toHaveLength(2); // pending + deleted

    const stored = await w.store.listRecurringPayments(ctx, customerId);
    expect(stored).toHaveLength(1);

    // No new plumbing needed downstream: createMigration already reads
    // whatever recurring payments are on file for the customer (see
    // api/service.ts). Three clean monthly Netflix debits clear the
    // planner's confidence threshold, so this plans as a verified payment,
    // not a manual-review exception.
    const { plan } = await w.service.createMigration(ctx, {
      customerId,
      destinationInstitutionId: seed.destinationId,
    });
    const recurringItem = plan.items.find((i) => i.productType === undefined);
    expect(recurringItem).toBeDefined();
    expect(recurringItem!.taskIds.length).toBeGreaterThan(0);
    expect(plan.exceptions.some((e) => e.code === 'LOW_CONFIDENCE_RECURRING_PAYMENT')).toBe(false);
  });

  it('rejects a provider that does not support transaction history', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(ctx, batch.id, [row(1)]);
    const noTransactionsProvider = { id: 'stub', normalizeAccounts: PowensProvider.normalizeAccounts };

    await expect(
      w.batches.detectRecurringPayments(ctx, imported[0]!, noTransactionsProvider, {}),
    ).rejects.toThrow(/does not support transaction history/);
  });
});

describe('batch planning', () => {
  it('plans every imported customer', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(
      ctx,
      batch.id,
      Array.from({ length: 40 }, (_, i) => row(i)),
    );
    const result = await w.batches.planBatch(ctx, batch.id, imported, { concurrency: 10 });

    expect(result.planned).toBe(40);
    expect(result.failed).toBe(0);
    expect(result.batch.status).toBe('PLANNED');

    const migrations = await w.store.listMigrations(ctx, { batchId: batch.id, limit: 100 });
    expect(migrations).toHaveLength(40);
  });

  it('reports progress as it goes', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(
      ctx,
      batch.id,
      Array.from({ length: 30 }, (_, i) => row(i)),
    );
    const seen: number[] = [];
    await w.batches.planBatch(ctx, batch.id, imported, {
      concurrency: 10,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([10, 20, 30]);
  });

  it('resumes rather than duplicating when a batch is re-planned', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(
      ctx,
      batch.id,
      Array.from({ length: 10 }, (_, i) => row(i)),
    );
    await w.batches.planBatch(ctx, batch.id, imported);
    await w.batches.planBatch(ctx, batch.id, imported);

    // Idempotency is keyed on (batch, customer), so a re-run of a partially
    // failed batch does not migrate anybody twice.
    const migrations = await w.store.listMigrations(ctx, { batchId: batch.id, limit: 100 });
    expect(migrations).toHaveLength(10);
  });

  it('isolates a failing customer from the rest of the population', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(
      ctx,
      batch.id,
      Array.from({ length: 12 }, (_, i) => row(i)),
    );
    const result = await w.batches.planBatch(ctx, batch.id, [...imported, 'cus_does_not_exist']);

    expect(result.planned).toBe(12);
    expect(result.failed).toBe(1);
    expect(result.failures[0]!.stage).toBe('PLAN');
    expect(result.failures[0]!.reason).toContain('not found');
  });

  it('counts customers whose plan carries a blocking exception', async () => {
    const batch = await newBatch();
    // An LEP the destination does not offer blocks each of these plans.
    const withLep = Array.from({ length: 5 }, (_, i) =>
      row(i, {
        products: [
          ...row(i).products,
          {
            type: 'LEP' as const,
            rawLabel: "Livret d'Épargne Populaire",
            balance: money(2_000_00),
            openedAt: '2019-01-01',
            metadata: {},
          },
        ],
      }),
    );
    const { imported } = await w.batches.importRows(ctx, batch.id, [
      ...withLep,
      ...Array.from({ length: 5 }, (_, i) => row(100 + i)),
    ]);
    const result = await w.batches.planBatch(ctx, batch.id, imported);

    expect(result.planned).toBe(10);
    expect(result.blocked).toBe(5);
  });
});

describe('exception queue', () => {
  it('surfaces blocking cases first, with the customer attached', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(ctx, batch.id, [
      row(1, {
        products: [
          ...row(1).products,
          {
            type: 'LEP' as const,
            rawLabel: "Livret d'Épargne Populaire",
            balance: money(1_000_00),
            openedAt: '2019-01-01',
            metadata: {},
          },
        ],
      }),
      row(2),
    ]);
    await w.batches.planBatch(ctx, batch.id, imported);

    const queue = await w.batches.exceptionQueue(ctx, batch.id);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0]!.severity).toBe('BLOCKING');
    expect(queue[0]!.customerId).toBeTruthy();
    expect(queue[0]!.resolution.length).toBeGreaterThan(0);
  });

  it('does not include another tenant\'s exceptions', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(ctx, batch.id, [row(1)]);
    await w.batches.planBatch(ctx, batch.id, imported);

    const other: TenantContext = { tenantId: 'ten_other', role: 'ADMIN' };
    expect(await w.batches.exceptionQueue(other, batch.id)).toHaveLength(0);
  });
});

describe('scale', () => {
  it('plans 500 customers without dropping any', async () => {
    const batch = await newBatch();
    const { imported } = await w.batches.importRows(
      ctx,
      batch.id,
      Array.from({ length: 500 }, (_, i) => row(i)),
    );
    const result = await w.batches.planBatch(ctx, batch.id, imported, { concurrency: 50 });

    expect(result.planned).toBe(500);
    const stats = await w.store.portfolioStats(ctx);
    expect(stats.total).toBe(500);
  }, 30_000);
});
