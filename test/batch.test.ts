import { describe, it, expect, beforeEach } from 'vitest';
import { wire, seedTenant, type Wiring } from '../src/api/bootstrap.js';
import type { SeedResult } from '../src/api/bootstrap.js';
import type { TenantContext } from '../src/store/types.js';
import type { ImportRow } from '../src/batch/pipeline.js';
import { money } from '../src/domain/types.js';

let w: Wiring;
let seed: SeedResult;
let ctx: TenantContext;

beforeEach(async () => {
  w = wire({ post: async () => ({ status: 200 }) });
  seed = await seedTenant(w);
  ctx = { tenantId: seed.tenantId, role: 'ADMIN' };
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
