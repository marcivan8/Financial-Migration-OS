/**
 * Demo runner: feeds the fictional customer through the engine and prints the
 * migration plan, task dependency graph, exceptions and completion score.
 *
 *   npm run demo              full plan for the standard fixture
 *   npm run demo -- --simulate  also walk the workflow to completion
 *   npm run demo -- --json      machine-readable plan on stdout
 */

import { DEMO_INPUT } from './fixtures/customer.js';
import { DESTINATION_NO_SECURITIES } from './fixtures/institutions.js';
import { planMigration, isPlanDispatchable } from './planner/planner.js';
import { Migration } from './workflow/stateMachine.js';
import { computeCompletion } from './workflow/completion.js';
import type { MigrationPlan, MigrationTask } from './domain/migration.js';
import type { Money } from './domain/types.js';

const args = new Set(process.argv.slice(2));
const JSON_MODE = args.has('--json');
const SIMULATE = args.has('--simulate');
const BLOCKED = args.has('--blocked');

const eur = (m?: Money): string =>
  m === undefined ? '—' : `${(m.amount / 100).toFixed(2).replace('.', ',')} €`;

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const ACTION_MARK: Record<string, string> = {
  AUTOMATED_MOBILITY: '→',
  CLOSE_AND_REOPEN: '⇄',
  INSTITUTION_TRANSFER: '⇒',
  KEEP_AT_ORIGIN: '⏸',
  MANUAL_REVIEW: '⚠',
  NOT_MIGRATABLE: '✖',
};

const SEVERITY_MARK: Record<string, string> = {
  BLOCKING: '✖',
  WARNING: '⚠',
  INFO: 'ℹ',
};

function rule(char = '─', width = 78): string {
  return char.repeat(width);
}

function printPlan(plan: MigrationPlan): void {
  const input = BLOCKED
    ? { ...DEMO_INPUT, destination: DESTINATION_NO_SECURITIES }
    : DEMO_INPUT;

  console.log(rule('═'));
  console.log('  MIGRATION PLAN');
  console.log(rule('═'));
  console.log(`  Migration    ${plan.migrationId}`);
  console.log(
    `  Customer     ${input.customer.identity.firstName} ${input.customer.identity.lastName} (${plan.customerId})`,
  );
  console.log(`  From         ${input.origin.name}`);
  console.log(`  To           ${input.destination.name}`);
  console.log(`  Generated    ${plan.generatedAt}`);
  console.log(
    `  Dispatchable ${isPlanDispatchable(plan) ? 'yes' : 'NO — blocking exceptions must clear first'}`,
  );
  console.log('');

  // ---- products -----------------------------------------------------------
  console.log(rule());
  console.log('  PRODUCTS');
  console.log(rule());
  for (const item of plan.items.filter((i) => i.subject === 'PRODUCT')) {
    const mark = ACTION_MARK[item.action] ?? '·';
    console.log('');
    console.log(`  ${mark} ${item.label}`);
    console.log(`      balance   ${eur(item.balance)}`);
    console.log(`      action    ${item.action}`);
    console.log(`      rule      ${item.ruleId}`);
    console.log(
      `      estimate  ${item.estimatedDurationDays} days` +
        (item.estimatedFees && item.estimatedFees.amount > 0
          ? `, fees ${eur(item.estimatedFees)}`
          : '') +
        (item.preservesTaxHistory ? ', tax history preserved' : ''),
    );
    console.log(`      why       ${wrap(item.rationale, 68, '                ')}`);
    for (const exc of item.exceptions) {
      console.log(
        `      ${SEVERITY_MARK[exc.severity]} ${exc.code}: ${wrap(exc.message, 60, '        ')}`,
      );
    }
  }

  // ---- recurring payments -------------------------------------------------
  const payments = plan.items.filter((i) => i.subject === 'RECURRING_PAYMENT');
  console.log('');
  console.log(rule());
  console.log(`  RECURRING RELATIONSHIPS (${payments.length})`);
  console.log(rule());
  for (const item of payments) {
    const mark = ACTION_MARK[item.action] ?? '·';
    const flag = item.exceptions.length > 0 ? '  ⚠ low confidence' : '';
    console.log(
      `  ${mark} ${item.label.padEnd(52).slice(0, 52)} ${eur(item.balance).padStart(12)}${flag}`,
    );
  }

  // ---- task graph ---------------------------------------------------------
  console.log('');
  console.log(rule());
  console.log(`  TASK GRAPH — ${plan.tasks.length} tasks, execution order`);
  console.log(rule());
  printTaskTree(plan);

  // ---- exceptions ---------------------------------------------------------
  console.log('');
  console.log(rule());
  console.log(`  EXCEPTIONS (${plan.exceptions.length})`);
  console.log(rule());
  if (plan.exceptions.length === 0) {
    console.log('  none');
  }
  for (const exc of plan.exceptions) {
    console.log('');
    console.log(`  ${SEVERITY_MARK[exc.severity]} [${exc.severity}] ${exc.code}`);
    console.log(`      ${wrap(exc.message, 68, '      ')}`);
    console.log(`      → ${wrap(exc.resolution, 66, '        ')}`);
  }

  // ---- estimates ----------------------------------------------------------
  console.log('');
  console.log(rule());
  console.log('  ESTIMATE');
  console.log(rule());
  console.log(
    `  Critical path   ${plan.estimatedTotalDurationDays} days ` +
      '(longest dependency chain, not the sum of all tasks)',
  );
  console.log(`  Transfer fees   ${eur(plan.estimatedTotalFees)}`);
}

function printTaskTree(plan: MigrationPlan): void {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  let lastItem: string | null | undefined = undefined;

  for (const id of plan.executionOrder) {
    const task = byId.get(id);
    if (!task) continue;

    if (task.itemId !== lastItem) {
      const item = plan.items.find((i) => i.id === task.itemId);
      console.log('');
      console.log(`  ┌─ ${item ? item.label : 'migration-level'}`);
      lastItem = task.itemId;
    }

    const deps =
      task.dependencies.length > 0 ? ` ← ${task.dependencies.join(', ')}` : '';
    console.log(
      `  │  ${task.id}  ${task.label.padEnd(56).slice(0, 56)} [${task.actor}]${deps}`,
    );
    for (const doc of task.documents) {
      console.log(`  │      · doc: ${doc.label} (${doc.providedBy})`);
    }
  }
}

function simulate(plan: MigrationPlan): void {
  const migration = new Migration(plan);
  console.log('');
  console.log(rule('═'));
  console.log('  WORKFLOW SIMULATION');
  console.log(rule('═'));

  migration.transitionTo('DATA_CONNECTED', 'origin bank connected');
  migration.transitionTo('ANALYZED', 'products classified');
  migration.transitionTo('PLAN_GENERATED', 'plan produced by engine');

  // Drain the graph in dependency order. A real executor would dispatch these
  // to institutions and wait on webhooks; here every task simply succeeds,
  // except one we deliberately block to show the exception path.
  const blockTarget = plan.tasks.find(
    (t: MigrationTask) => t.type === 'AWAIT_TRANSFER_SETTLEMENT',
  );

  let guard = 0;
  while (guard++ < 1000) {
    const ready = migration.ready();
    if (ready.length === 0) break;
    for (const task of ready) {
      migration.startTask(task.id);
      if (blockTarget && task.id === blockTarget.id && task.status !== 'BLOCKED') {
        migration.blockTask(
          task.id,
          'ORIGIN_UNRESPONSIVE',
          'Origin institution has not acknowledged the PEA transfer request after 30 days.',
        );
        continue;
      }
      migration.completeTask(task.id);
    }
  }

  const report = computeCompletion(plan, migration);

  console.log(`  State            ${migration.state}`);
  console.log(`  Events recorded  ${migration.events.length}`);
  console.log('');
  console.log('  Financial Relationship Migration Completion Rate');
  console.log('');
  for (const cat of report.categories) {
    const bar = '█'.repeat(Math.round(cat.completion * 20)).padEnd(20, '·');
    const note =
      cat.stayingCount > 0
        ? `  (${cat.stayingCount} stays at origin by design)`
        : cat.impossibleCount > 0
          ? `  (${cat.impossibleCount} excluded)`
          : '';
    console.log(
      `    ${cat.category.padEnd(15)} ${bar} ${pct(cat.completion).padStart(6)}${note}`,
    );
  }
  console.log('');
  console.log(`    ${'OVERALL'.padEnd(15)} ${pct(report.overall).padStart(27)}`);

  if (report.excluded.length > 0) {
    console.log('');
    console.log('  Excluded from the score (cannot move — not an execution failure):');
    for (const ex of report.excluded) {
      console.log(`    ✖ ${ex.label}`);
    }
  }

  const blocked = migration.tasks.filter((t) => t.status === 'BLOCKED');
  if (blocked.length > 0) {
    console.log('');
    console.log('  Open exception cases:');
    for (const t of blocked) {
      console.log(`    ⚠ ${t.id}  ${t.label}  [${t.actor}]`);
    }
  }
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + w).length > width) {
      lines.push(line.trimEnd());
      line = '';
    }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${indent}`);
}

// ---------------------------------------------------------------------------

const input = BLOCKED
  ? { ...DEMO_INPUT, destination: DESTINATION_NO_SECURITIES }
  : DEMO_INPUT;

const plan = planMigration(input, {
  migrationId: 'mig_0001',
  now: new Date('2026-08-31T10:00:00.000Z'),
});

if (JSON_MODE) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  printPlan(plan);
  if (SIMULATE) simulate(plan);
}
