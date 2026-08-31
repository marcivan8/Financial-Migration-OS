import { money, type ProductType } from '../domain/types.js';
import type { TenantContext } from '../store/types.js';
import type { ImportRow } from './pipeline.js';
import type { Wiring } from '../api/bootstrap.js';

/**
 * Generate a realistically messy population for the mass-migration path.
 *
 * The distribution matters more than the volume: a demo where every customer
 * migrates cleanly proves nothing, because the product exists for the ones that
 * do not. Roughly a fifth of this population carries something the destination
 * cannot take, and a slice has low-confidence direct debits.
 */

const FIRST = ['Camille', 'Léa', 'Hugo', 'Sofia', 'Nathan', 'Inès', 'Louis', 'Jade', 'Adam', 'Manon'];
const LAST = ['Dubreuil', 'Moreau', 'Lefèvre', 'Garnier', 'Rousseau', 'Benali', 'Da Silva', 'Marchand'];

const MERCHANTS: [string, ImportRow['recurringPayments'] extends (infer R)[] | undefined ? R extends { category: infer C } ? C : never : never, number][] = [
  ['Employeur SA', 'SALARY', 2_650_00],
  ['SCI Bellevue', 'RENT', 1_050_00],
  ['Fournisseur Énergie', 'UTILITIES', 88_40],
  ['Télécom Hexagone', 'TELECOM', 29_99],
  ['DGFiP', 'TAX', 285_00],
];

/** Deterministic PRNG so a demo run is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function generatePopulation(count: number, seed = 42): ImportRow[] {
  const rand = rng(seed);
  const rows: ImportRow[] = [];

  for (let i = 0; i < count; i++) {
    const r = rand();
    const products: ImportRow['products'] = [
      {
        type: 'CURRENT_ACCOUNT',
        rawLabel: 'Compte de dépôt',
        balance: money(Math.round(rand() * 4_000_00)),
        openedAt: '2014-05-02',
        metadata: {},
      },
      {
        type: 'LIVRET_A',
        rawLabel: 'Livret A',
        balance: money(Math.round(rand() * 22_950_00)),
        openedAt: '2014-05-02',
        metadata: {},
      },
    ];

    // ~40% hold securities.
    if (r > 0.6) {
      products.push({
        type: 'PEA',
        rawLabel: "Plan d'Épargne en Actions",
        balance: money(Math.round(rand() * 60_000_00)),
        openedAt: '2018-02-11',
        metadata: {
          fiscalSeniorityDate: '2018-02-11',
          cumulativePayments: money(20_000_00),
          securitiesLineCount: 1 + Math.floor(rand() * 14),
        },
      });
    }
    // ~20% hold an LEP the destination does not offer — the blocking case.
    if (r < 0.2) {
      products.push({
        type: 'LEP' as ProductType,
        rawLabel: "Livret d'Épargne Populaire",
        balance: money(Math.round(rand() * 10_000_00)),
        openedAt: '2019-01-15',
        metadata: {},
      });
    }
    // ~15% hold an assurance-vie that stays with the insurer.
    if (r > 0.85) {
      products.push({
        type: 'ASSURANCE_VIE' as ProductType,
        rawLabel: 'Contrat Avenir',
        balance: money(Math.round(rand() * 90_000_00)),
        openedAt: '2016-09-30',
        metadata: { underwriterName: 'Assurances Meridienne' },
      });
    }

    const payments = MERCHANTS.slice(0, 2 + Math.floor(rand() * 4)).map(
      ([merchant, category, amount]) => ({
        merchant,
        amount: money(amount),
        frequency: 'MONTHLY' as const,
        category,
        direction: (category === 'SALARY' ? 'INBOUND' : 'OUTBOUND') as
          | 'INBOUND'
          | 'OUTBOUND',
        // ~12% of detections are shaky and must reach a human first.
        confidence: rand() < 0.12 ? 0.4 + rand() * 0.25 : 0.9 + rand() * 0.09,
        migrationStatus: 'NOT_STARTED' as const,
      }),
    );

    rows.push({
      externalRef: `EXT-${String(i).padStart(5, '0')}`,
      firstName: FIRST[i % FIRST.length]!,
      lastName: LAST[i % LAST.length]!,
      dateOfBirth: '1988-06-21',
      products,
      recurringPayments: payments,
    });
  }

  return rows;
}

/**
 * Import, plan, and drive a population to a spread of realistic states, so the
 * dashboard shows a portfolio mid-flight rather than one uniformly happy row.
 */
export async function seedPopulation(
  w: Wiring,
  ctx: TenantContext,
  params: { count?: number; originId: string; destinationId: string },
): Promise<{ batchId: string; planned: number; blocked: number }> {
  const count = params.count ?? 120;
  const batch = await w.batches.createBatch(ctx, {
    name: 'Portfolio transfer — Meridienne retail book',
    originInstitutionId: params.originId,
    destinationInstitutionId: params.destinationId,
  });

  const { imported } = await w.batches.importRows(ctx, batch.id, generatePopulation(count));
  const result = await w.batches.planBatch(ctx, batch.id, imported, { concurrency: 40 });

  const migrations = await w.store.listMigrations(ctx, { batchId: batch.id, limit: count });
  const rand = rng(7);

  for (const m of migrations) {
    const roll = rand();
    if (roll < 0.15) continue; // still awaiting the customer

    await w.service.authorize(ctx, m.id);
    if (roll < 0.35) continue; // authorized, execution not started

    if (roll < 0.55) {
      // Stalled waiting on the origin institution's securities desk.
      await w.service.simulate(ctx, m.id, 'AWAIT_TRANSFER_SETTLEMENT');
    } else if (roll < 0.7) {
      // Stalled waiting for the origin to confirm a closure.
      await w.service.simulate(ctx, m.id, 'CLOSE_ORIGIN_PRODUCT');
    } else {
      await w.service.simulate(ctx, m.id);
    }
  }

  return { batchId: batch.id, planned: result.planned, blocked: result.blocked };
}
