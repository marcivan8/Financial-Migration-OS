import type { RelationshipCategory } from '../domain/types.js';
import type { MigrationPlan, MigrationPlanItem } from '../domain/migration.js';
import type { Migration } from './stateMachine.js';

/**
 * Financial Relationship Migration Completion Rate.
 *
 * The north-star metric from §19 of the brief. It answers "did the customer's
 * financial relationship actually move", which is a different and much harder
 * question than "was an account opened at the destination".
 *
 * The scoring rule that matters: an item the engine determined CANNOT move
 * (NOT_MIGRATABLE) is excluded from the denominator, while an item that merely
 * hasn't moved yet counts as incomplete. Folding "legally impossible" into
 * "not done" would let an institution look 60% complete forever and would hide
 * the real signal, which is that a chunk of the customer's financial life is
 * still at the old bank by design.
 */

export type CategoryOutcome = 'MIGRATING' | 'STAYS_AT_ORIGIN' | 'IMPOSSIBLE';

export interface CategoryScore {
  category: RelationshipCategory;
  /** 0..1 across the migrating items in this category. */
  completion: number;
  itemCount: number;
  migratingCount: number;
  stayingCount: number;
  impossibleCount: number;
  outcome: CategoryOutcome;
}

export interface CompletionReport {
  migrationId: string;
  /** 0..1 over items that are actually supposed to move. */
  overall: number;
  categories: CategoryScore[];
  /** Items excluded from the score, with the reason. */
  excluded: { itemId: string; label: string; reason: string }[];
  blockingExceptions: number;
}

function classify(item: MigrationPlanItem): CategoryOutcome {
  if (item.action === 'NOT_MIGRATABLE') return 'IMPOSSIBLE';
  if (item.action === 'KEEP_AT_ORIGIN') return 'STAYS_AT_ORIGIN';
  return 'MIGRATING';
}

export function computeCompletion(
  plan: MigrationPlan,
  migration: Migration,
): CompletionReport {
  const byCategory = new Map<RelationshipCategory, MigrationPlanItem[]>();
  for (const item of plan.items) {
    const bucket = byCategory.get(item.category) ?? [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  }

  const categories: CategoryScore[] = [];
  const excluded: CompletionReport['excluded'] = [];
  let weightedSum = 0;
  let weightedCount = 0;

  const order: RelationshipCategory[] = [
    'BANKING',
    'INCOME',
    'DIRECT_DEBITS',
    'SAVINGS',
    'INVESTMENTS',
    'INSURANCE',
    'CREDIT',
  ];

  for (const category of order) {
    const items = byCategory.get(category);
    if (!items || items.length === 0) continue;

    const migrating = items.filter((i) => classify(i) === 'MIGRATING');
    const staying = items.filter((i) => classify(i) === 'STAYS_AT_ORIGIN');
    const impossible = items.filter((i) => classify(i) === 'IMPOSSIBLE');

    for (const i of impossible) {
      excluded.push({
        itemId: i.id,
        label: i.label,
        reason: i.rationale,
      });
    }

    const scored = [...migrating, ...staying];
    const completion =
      scored.length === 0
        ? 0
        : scored.reduce((sum, i) => sum + migration.itemCompletion(i.id), 0) / scored.length;

    weightedSum += completion * scored.length;
    weightedCount += scored.length;

    categories.push({
      category,
      completion,
      itemCount: items.length,
      migratingCount: migrating.length,
      stayingCount: staying.length,
      impossibleCount: impossible.length,
      outcome:
        migrating.length > 0
          ? 'MIGRATING'
          : staying.length > 0
            ? 'STAYS_AT_ORIGIN'
            : 'IMPOSSIBLE',
    });
  }

  return {
    migrationId: plan.migrationId,
    overall: weightedCount === 0 ? 0 : weightedSum / weightedCount,
    categories,
    excluded,
    blockingExceptions: plan.exceptions.filter((e) => e.severity === 'BLOCKING').length,
  };
}
