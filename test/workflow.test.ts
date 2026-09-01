import { describe, it, expect } from 'vitest';
import { planMigration } from '../src/planner/planner.js';
import { Migration, IllegalTransitionError } from '../src/workflow/stateMachine.js';
import { computeCompletion } from '../src/workflow/completion.js';
import { DEMO_INPUT } from '../src/fixtures/customer.js';

const NOW = new Date('2026-08-31T10:00:00.000Z');
const makePlan = () => planMigration(DEMO_INPUT, { migrationId: 'mig_wf', now: NOW });

/** Drive the graph to completion, optionally blocking one task type. */
function drain(migration: Migration, blockType?: string): void {
  let guard = 0;
  while (guard++ < 500) {
    const ready = migration.ready();
    if (ready.length === 0) return;
    for (const task of ready) {
      migration.startTask(task.id);
      if (blockType && task.type === blockType) {
        migration.blockTask(task.id, 'ORIGIN_UNRESPONSIVE', 'no answer from origin');
        continue;
      }
      migration.completeTask(task.id);
    }
  }
  throw new Error('drain did not converge — the task graph is not making progress');
}

describe('state machine', () => {
  it('walks the happy path in order', () => {
    const m = new Migration(makePlan());
    expect(m.state).toBe('CREATED');
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');
    expect(m.state).toBe('PLAN_GENERATED');
  });

  it('refuses to jump straight to COMPLETED', () => {
    const m = new Migration(makePlan());
    expect(() => m.transitionTo('COMPLETED')).toThrow(IllegalTransitionError);
  });

  it('refuses to leave a terminal state', () => {
    const m = new Migration(makePlan());
    m.transitionTo('CANCELLED');
    expect(() => m.transitionTo('IN_PROGRESS')).toThrow(IllegalTransitionError);
    expect(m.isTerminal).toBe(true);
  });

  it('records an event for every state change', () => {
    const m = new Migration(makePlan());
    const before = m.events.length;
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    expect(m.events.length).toBe(before + 2);
    expect(m.events.at(-1)!.type).toBe('StateChanged');
  });

  it('numbers events monotonically for replay', () => {
    const m = new Migration(makePlan());
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    const seqs = m.events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('task execution guards', () => {
  it('refuses to start a task whose dependencies are unmet', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    const dependent = plan.tasks.find((t) => t.dependencies.length > 0)!;
    expect(() => m.startTask(dependent.id)).toThrow(/unmet dependencies/);
  });

  it('escalates to ACTION_REQUIRED when any task is blocked, whatever else is in flight', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');
    drain(m, 'AWAIT_TRANSFER_SETTLEMENT');
    // A blocked settlement outranks everything else in flight: the migration
    // must read as needing a human, not as quietly progressing.
    expect(m.state).toBe('ACTION_REQUIRED');
  });

  it('surfaces a blocked task as an open exception case', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');
    drain(m, 'AWAIT_TRANSFER_SETTLEMENT');
    const blocked = m.tasks.filter((t) => t.status === 'BLOCKED');
    expect(blocked.length).toBeGreaterThan(0);
    expect(m.events.some((e) => e.type === 'ExceptionRaised')).toBe(true);
  });

  it('reports WAITING_EXTERNAL over IN_PROGRESS when nothing is blocked but something is waiting on a third party', () => {
    // Isolates the middle tier of reconcileState's priority order. The
    // "blocked outranks everything" test above only proves the top tier;
    // this proves that with nothing BLOCKED, one WAITING_EXTERNAL task
    // still outranks any number of ordinary IN_PROGRESS ones, rather than
    // the migration reading as merely "in progress" while it is actually
    // stalled on a third party.
    const plan = makePlan();
    const m = new Migration(plan);
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');

    // Drain normally — completing everything as it becomes ready, so the
    // graph actually reaches a branch that waits on a third party — and
    // only once a WAITING_EXTERNAL task has appeared do we hold one more
    // ordinary task open instead of completing it. Holding one back from
    // the very start risks it gating the only path to a WAITING_EXTERNAL
    // task in the first place; holding one back after we've already seen
    // one avoids that.
    let heldBack: string | undefined;
    let sawWaiting = false;
    let guard = 0;
    while (guard++ < 500) {
      const ready = m.ready();
      if (ready.length === 0) break;
      for (const task of ready) {
        m.startTask(task.id);
        const status = m.tasks.find((t) => t.id === task.id)!.status;
        if (status === 'WAITING_EXTERNAL') {
          sawWaiting = true;
          continue; // let a real wait sit and wait
        }
        if (task.type === 'CUSTOMER_AUTHORIZATION') {
          m.completeTask(task.id);
          continue;
        }
        if (sawWaiting && !heldBack) {
          // An ordinary task nobody has finished yet — left IN_PROGRESS,
          // alongside the wait that's already in flight elsewhere.
          heldBack = task.id;
          continue;
        }
        m.completeTask(task.id);
      }
      if (heldBack) break;
    }

    expect(heldBack).toBeDefined();
    const statuses = m.tasks.map((t) => t.status);
    expect(statuses).toContain('IN_PROGRESS');
    expect(statuses).toContain('WAITING_EXTERNAL');
    expect(statuses).not.toContain('BLOCKED');
    expect(m.state).toBe('WAITING_EXTERNAL');
  });
});

describe('completion scoring', () => {
  it('is 0 before any work is done', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    expect(computeCompletion(plan, m).overall).toBe(0);
  });

  it('reaches 100% when every migrating item is finished', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');
    drain(m);
    const report = computeCompletion(plan, m);
    expect(report.overall).toBeCloseTo(1, 5);
  });

  it('excludes legally impossible items rather than counting them as failures', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');
    drain(m);
    const report = computeCompletion(plan, m);
    // The LEP cannot land at the destination — that is a product-shelf fact,
    // not an execution failure, so it must not drag the score below 100%.
    expect(report.excluded.length).toBeGreaterThan(0);
    expect(report.excluded.some((e) => e.label.includes('LEP'))).toBe(true);
    expect(report.overall).toBeCloseTo(1, 5);
  });

  it('scores per relationship category, not per account', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    const report = computeCompletion(plan, m);
    const names = report.categories.map((c) => c.category);
    expect(names).toContain('BANKING');
    expect(names).toContain('SAVINGS');
    expect(names).toContain('INVESTMENTS');
    expect(names).toContain('INCOME');
    expect(names).toContain('DIRECT_DEBITS');
  });

  it('drops when part of the relationship stalls', () => {
    const plan = makePlan();
    const m = new Migration(plan);
    m.transitionTo('DATA_CONNECTED');
    m.transitionTo('ANALYZED');
    m.transitionTo('PLAN_GENERATED');
    drain(m, 'AWAIT_TRANSFER_SETTLEMENT');
    const report = computeCompletion(plan, m);
    const investments = report.categories.find((c) => c.category === 'INVESTMENTS')!;
    expect(investments.completion).toBeLessThan(1);
    expect(report.overall).toBeLessThan(1);
    // Banking is unaffected by a securities stall — that separation is the
    // whole point of scoring by relationship rather than by overall progress.
    const banking = report.categories.find((c) => c.category === 'BANKING')!;
    expect(banking.completion).toBe(1);
  });
});
