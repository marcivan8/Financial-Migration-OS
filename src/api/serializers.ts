import type { MigrationPlan, MigrationTask } from '../domain/migration.js';
import type { Money } from '../domain/types.js';
import type { CompletionReport } from '../workflow/completion.js';
import type { MigrationRecord } from '../store/types.js';

/**
 * Wire format.
 *
 * snake_case on the wire, camelCase inside — institutions integrating this will
 * be reading it next to Stripe and their own core-banking APIs. Money is always
 * `{amount_minor, currency}`, never a decimal string, so nobody's JSON parser
 * turns 8200.10 into 8200.099999.
 */

const money = (m?: Money) =>
  m === undefined ? null : { amount_minor: m.amount, currency: m.currency };

export const migrationSummary = (m: MigrationRecord) => ({
  id: m.id,
  customer_id: m.customerId,
  origin_institution_id: m.originInstitutionId,
  destination_institution_id: m.destinationInstitutionId,
  batch_id: m.batchId,
  state: m.state,
  completion: Number(m.completion.toFixed(4)),
  blocking_exceptions: m.blockingExceptionCount,
  estimated_duration_days: m.estimatedDurationDays,
  estimated_fees: { amount_minor: m.estimatedFeesMinor, currency: 'EUR' },
  created_at: m.createdAt,
  updated_at: m.updatedAt,
  completed_at: m.completedAt,
});

export const planItemJson = (plan: MigrationPlan, subject?: 'PRODUCT' | 'RECURRING_PAYMENT') =>
  plan.items
    .filter((i) => !subject || i.subject === subject)
    .map((i) => ({
      id: i.id,
      subject: i.subject,
      subject_id: i.subjectId,
      product_type: i.productType ?? null,
      category: i.category,
      label: i.label,
      action: i.action,
      // Provenance travels on the wire too: an institution's compliance team
      // can trace any decision back to a rule without calling support.
      rule_id: i.ruleId,
      rationale: i.rationale,
      balance: money(i.balance),
      preserves_tax_history: i.preservesTaxHistory,
      estimated_duration_days: i.estimatedDurationDays,
      estimated_fees: money(i.estimatedFees),
      task_ids: i.taskIds,
      exceptions: i.exceptions.map(exceptionJson),
    }));

export const exceptionJson = (e: {
  id: string;
  code: string;
  severity: string;
  message: string;
  resolution: string;
  subjectId: string | null;
}) => ({
  id: e.id,
  code: e.code,
  severity: e.severity,
  message: e.message,
  resolution: e.resolution,
  subject_id: e.subjectId,
});

export const taskJson = (t: MigrationTask) => ({
  id: t.id,
  item_id: t.itemId,
  type: t.type,
  label: t.label,
  status: t.status,
  actor: t.actor,
  sla_days: t.slaDays,
  dependencies: t.dependencies,
  documents: t.documents.map((d) => ({
    code: d.code,
    label: d.label,
    provided_by: d.providedBy,
    mandatory: d.mandatory,
  })),
});

export const planJson = (plan: MigrationPlan) => ({
  migration_id: plan.migrationId,
  generated_at: plan.generatedAt,
  items: planItemJson(plan),
  tasks: plan.tasks.map(taskJson),
  execution_order: plan.executionOrder,
  exceptions: plan.exceptions.map(exceptionJson),
  estimated_duration_days: plan.estimatedTotalDurationDays,
  estimated_fees: money(plan.estimatedTotalFees),
  dispatchable: !plan.exceptions.some((e) => e.severity === 'BLOCKING'),
});

export const completionJson = (report: CompletionReport) => ({
  overall: Number(report.overall.toFixed(4)),
  categories: report.categories.map((c) => ({
    category: c.category,
    completion: Number(c.completion.toFixed(4)),
    items: c.itemCount,
    migrating: c.migratingCount,
    staying_at_origin: c.stayingCount,
    excluded: c.impossibleCount,
  })),
  excluded: report.excluded.map((e) => ({
    item_id: e.itemId,
    label: e.label,
    reason: e.reason,
  })),
  blocking_exceptions: report.blockingExceptions,
});

/** RFC 9457 problem details. */
export const problem = (
  status: number,
  title: string,
  detail: string,
  extra: Record<string, unknown> = {},
) => ({
  type: `https://docs.fmos.dev/errors/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  title,
  status,
  detail,
  ...extra,
});

/** Documents outstanding across a plan, grouped by who owes them. */
export const documentsJson = (tasks: MigrationTask[]) => {
  const rows: {
    code: string;
    label: string;
    provided_by: string;
    mandatory: boolean;
    task_id: string;
    status: string;
  }[] = [];
  for (const t of tasks) {
    for (const d of t.documents) {
      rows.push({
        code: d.code,
        label: d.label,
        provided_by: d.providedBy,
        mandatory: d.mandatory,
        task_id: t.id,
        status: t.status === 'COMPLETED' ? 'PROVIDED' : 'OUTSTANDING',
      });
    }
  }
  return rows;
};
