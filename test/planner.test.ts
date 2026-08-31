import { describe, it, expect } from 'vitest';
import { planMigration, isPlanDispatchable } from '../src/planner/planner.js';
import { topologicalOrder, criticalPathDays, CyclicDependencyError } from '../src/planner/taskGraph.js';
import { DEMO_INPUT } from '../src/fixtures/customer.js';
import { DESTINATION_NO_SECURITIES } from '../src/fixtures/institutions.js';
import type { MigrationTask } from '../src/domain/migration.js';

const NOW = new Date('2026-08-31T10:00:00.000Z');
const plan = planMigration(DEMO_INPUT, { migrationId: 'mig_test', now: NOW });

const taskById = (id: string): MigrationTask => {
  const t = plan.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
const indexOf = (id: string) => plan.executionOrder.indexOf(id);
const itemFor = (subjectId: string) => {
  const i = plan.items.find((x) => x.subjectId === subjectId);
  if (!i) throw new Error(`no item for ${subjectId}`);
  return i;
};

describe('plan shape', () => {
  it('produces one item per product and per recurring payment', () => {
    expect(plan.items.filter((i) => i.subject === 'PRODUCT')).toHaveLength(
      DEMO_INPUT.products.length,
    );
    expect(plan.items.filter((i) => i.subject === 'RECURRING_PAYMENT')).toHaveLength(
      DEMO_INPUT.recurringPayments.length,
    );
  });

  it('attributes every item to a named rule', () => {
    for (const item of plan.items) {
      expect(item.ruleId, `${item.label} has no rule provenance`).not.toBe('');
    }
  });

  it('orders every task and leaves none out', () => {
    expect(plan.executionOrder).toHaveLength(plan.tasks.length);
    expect(new Set(plan.executionOrder).size).toBe(plan.tasks.length);
  });

  it('is deterministic across runs', () => {
    const again = planMigration(DEMO_INPUT, { migrationId: 'mig_test', now: NOW });
    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
  });
});

describe('dependency ordering — the part that protects the customer', () => {
  it('closes the origin Livret A BEFORE opening the destination one', () => {
    const item = itemFor('prd_02_livreta');
    const close = item.taskIds.map(taskById).find((t) => t.type === 'CLOSE_ORIGIN_PRODUCT')!;
    const open = item.taskIds.map(taskById).find((t) => t.type === 'OPEN_DESTINATION_PRODUCT')!;
    // One Livret A per holder nationwide: opening first would put the customer
    // in breach and the destination would reject the opening.
    expect(indexOf(close.id)).toBeLessThan(indexOf(open.id));
    expect(open.dependencies).toContain(close.id);
  });

  it('opens the destination PEA BEFORE requesting the transfer', () => {
    const item = itemFor('prd_04_pea');
    const open = item.taskIds.map(taskById).find((t) => t.type === 'OPEN_DESTINATION_PRODUCT')!;
    const request = item.taskIds.map(taskById).find((t) => t.type === 'REQUEST_INSTITUTION_TRANSFER')!;
    expect(indexOf(open.id)).toBeLessThan(indexOf(request.id));
  });

  it('verifies the balance only after the transfer has settled', () => {
    const item = itemFor('prd_04_pea');
    const settle = item.taskIds.map(taskById).find((t) => t.type === 'AWAIT_TRANSFER_SETTLEMENT')!;
    const verify = item.taskIds.map(taskById).find((t) => t.type === 'VERIFY_BALANCE')!;
    expect(indexOf(settle.id)).toBeLessThan(indexOf(verify.id));
  });

  it('gates every institution-facing task behind customer authorization', () => {
    const auth = plan.tasks.find((t) => t.type === 'CUSTOMER_AUTHORIZATION')!;
    const authIndex = indexOf(auth.id);
    const institutionTasks = plan.tasks.filter(
      (t) => t.actor === 'ORIGIN_INSTITUTION' || t.actor === 'DESTINATION_INSTITUTION',
    );
    expect(institutionTasks.length).toBeGreaterThan(0);
    for (const t of institutionTasks) {
      expect(indexOf(t.id), `${t.id} runs before authorization`).toBeGreaterThan(authIndex);
    }
  });

  it('every task except the first has at least one dependency', () => {
    const roots = plan.tasks.filter((t) => t.dependencies.length === 0);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.type).toBe('CONNECT_ORIGIN');
  });
});

describe('topological sort', () => {
  it('rejects a cyclic graph instead of dispatching it', () => {
    const cyclic: MigrationTask[] = [
      { ...taskById(plan.executionOrder[0]!), id: 'a', dependencies: ['b'] },
      { ...taskById(plan.executionOrder[0]!), id: 'b', dependencies: ['a'] },
    ];
    expect(() => topologicalOrder(cyclic)).toThrow(CyclicDependencyError);
  });

  it('measures the critical path, not the sum of every SLA', () => {
    const totalSla = plan.tasks.reduce((s, t) => s + t.slaDays, 0);
    const critical = criticalPathDays(plan.tasks, plan.executionOrder);
    expect(critical).toBeGreaterThan(0);
    expect(critical).toBeLessThan(totalSla);
  });
});

describe('recurring payments', () => {
  it('only verifies payments already carried by the mobility mandate', () => {
    const salary = itemFor('rec_01_salary');
    expect(salary.action).toBe('AUTOMATED_MOBILITY');
    expect(salary.taskIds.map(taskById).map((t) => t.type)).toEqual(['VERIFY_PAYMENT_REDIRECTED']);
  });

  it('routes a low-confidence detection to a human before notifying anyone', () => {
    const gym = itemFor('rec_07_gym');
    const types = gym.taskIds.map(taskById).map((t) => t.type);
    expect(types[0]).toBe('MANUAL_REVIEW');
    expect(gym.exceptions.map((e) => e.code)).toContain('LOW_CONFIDENCE_RECURRING_PAYMENT');
  });
});

describe('dispatch gating', () => {
  it('refuses to call a plan dispatchable while a blocking exception stands', () => {
    // The fixture destination does not offer the LEP.
    expect(plan.exceptions.some((e) => e.severity === 'BLOCKING')).toBe(true);
    expect(isPlanDispatchable(plan)).toBe(false);
  });

  it('still plans everything else around the blocked item', () => {
    const lep = itemFor('prd_07_lep');
    expect(lep.taskIds).toHaveLength(0);
    expect(plan.items.filter((i) => i.taskIds.length > 0).length).toBeGreaterThan(5);
  });

  it('degrades gracefully when the destination has no securities desk', () => {
    const degraded = planMigration(
      { ...DEMO_INPUT, destination: DESTINATION_NO_SECURITIES },
      { migrationId: 'mig_degraded', now: NOW },
    );
    const pea = degraded.items.find((i) => i.subjectId === 'prd_04_pea')!;
    expect(pea.action).toBe('NOT_MIGRATABLE');
    expect(degraded.estimatedTotalFees.amount).toBe(0);
  });
});

describe('estimates', () => {
  it('caps total transfer fees at the sum of per-product statutory caps', () => {
    expect(plan.estimatedTotalFees).toEqual({ amount: 135_00, currency: 'EUR' });
  });
});

describe('id uniqueness across migrations', () => {
  // These ids are primary keys in migration_tasks / plan_items /
  // migration_exceptions. A plan-local counter made every migration mint
  // tsk_0001, which in a shared store silently served one customer's task
  // statuses as another's — a migration reported its neighbour's progress.
  const a = planMigration(DEMO_INPUT, { migrationId: 'mig_aaa', now: NOW });
  const b = planMigration(DEMO_INPUT, { migrationId: 'mig_bbb', now: NOW });

  it('shares no task ids between two migrations of the same customer', () => {
    const overlap = a.tasks
      .map((t) => t.id)
      .filter((id) => b.tasks.some((t) => t.id === id));
    expect(overlap).toEqual([]);
  });

  it('shares no plan-item ids', () => {
    const overlap = a.items.map((i) => i.id).filter((id) => b.items.some((i) => i.id === id));
    expect(overlap).toEqual([]);
  });

  it('shares no exception ids', () => {
    expect(a.exceptions.length).toBeGreaterThan(0);
    const overlap = a.exceptions
      .map((e) => e.id)
      .filter((id) => b.exceptions.some((e) => e.id === id));
    expect(overlap).toEqual([]);
  });

  it('keeps ids unique within a single plan too', () => {
    const ids = [
      ...a.tasks.map((t) => t.id),
      ...a.items.map((i) => i.id),
      ...a.exceptions.map((e) => e.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces ids by migration so they stay traceable', () => {
    expect(a.tasks.every((t) => t.id.startsWith('mig_aaa.'))).toBe(true);
  });
});
