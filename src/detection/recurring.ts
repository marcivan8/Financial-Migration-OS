import type { PaymentFrequency, RecurringPayment, Transaction } from '../domain/types.js';

/**
 * Recurring-payment detection.
 *
 * Input: a customer's transaction history (already normalised to the
 * canonical `Transaction` shape by a connectivity provider — see
 * `connectivity/powens.ts`'s `normalizePowensTransactions`).
 * Output: `RecurringPayment[]`, the same shape `planner/planner.ts` already
 * consumes. Nothing downstream changes: a low-confidence detection here
 * routes into the planner's existing `LOW_CONFIDENCE_RECURRING_PAYMENT`
 * exception and `MANUAL_REVIEW` task exactly the way a hand-imported one
 * does (see `test/batch.test.ts`'s `row()` fixture, which has always
 * supplied `recurringPayments` by hand). This file is what can now produce
 * that array from real transaction data instead.
 *
 * Pure and deterministic, same as the rest of this engine's decision path:
 * same transactions in, same recurring payments out, every time. No model,
 * no external service — a merchant + amount + interval heuristic, openly
 * documented rather than a black box.
 *
 * ---------------------------------------------------------------------
 * The thresholds below are a first calibration, not a validated model.
 * They were chosen to behave sensibly against the fixtures in
 * `test/detection.test.ts` (a clean monthly salary, a utility bill with
 * real amount variation, a quarterly premium, irregular same-merchant
 * shopping that must NOT be flagged) and are deliberately exported so a
 * caller — or a future recalibration against real customer data — can
 * override them without forking this file. Tightening or loosening them
 * against live data is exactly the kind of follow-up this repo's other
 * "documented, not integration-tested" caveats (see powens.ts) ask for.
 * ---------------------------------------------------------------------
 */

/** Fewer than this many occurrences and there is no interval to measure — two dates are a coincidence, not a cadence. */
export const MIN_OCCURRENCES = 3;

/**
 * How far a transaction's amount may sit from its cluster's running median,
 * relatively, and still count as "the same recurring relationship." Wide
 * enough to keep a utility bill that moves 10-20% month to month in one
 * cluster; narrow enough that a €12.99 subscription and a €150 one-off
 * purchase from the same retailer land in different clusters.
 */
export const AMOUNT_CLUSTER_TOLERANCE = 0.25;

/**
 * Coefficient of variation (stddev / mean) of the gaps between occurrences,
 * above which the dates are not "regular" at all — same merchant, same
 * rough amount, but no cadence (weekly grocery runs, for instance). This is
 * a hard gate, not a confidence penalty: an irregular date pattern isn't a
 * recurring payment at a lower confidence, it is a different phenomenon
 * (repeat custom) that this detector deliberately does not report.
 */
export const INTERVAL_REGULARITY_CV_CAP = 0.4;

/** How close the mean gap must land to a frequency bucket's target, relatively, to be classified into it at all. */
const FREQUENCY_MATCH_TOLERANCE = 0.25;

const FREQUENCY_TARGET_DAYS: Record<PaymentFrequency, number> = {
  WEEKLY: 7,
  MONTHLY: 30,
  QUARTERLY: 91,
  ANNUAL: 365,
};

function normalizeCounterparty(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: number[], avg: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((s, x) => s + (x - avg) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Greedy 1D clustering by relative distance to the running cluster's
 * median amount. Not a real clustering algorithm — sorted-and-greedy is a
 * few lines instead of a dependency, and "amounts within ~25% of each
 * other" does not need k-means to get right.
 */
function clusterByAmount(txs: Transaction[]): Transaction[][] {
  const sorted = [...txs].sort((a, b) => Math.abs(a.amount.amount) - Math.abs(b.amount.amount));
  const clusters: Transaction[][] = [];

  for (const tx of sorted) {
    const abs = Math.abs(tx.amount.amount);
    const current = clusters[clusters.length - 1];
    if (current) {
      const currentAbs = current.map((t) => Math.abs(t.amount.amount)).sort((a, b) => a - b);
      const median = currentAbs[Math.floor(currentAbs.length / 2)]!;
      if (median > 0 && Math.abs(abs - median) / median <= AMOUNT_CLUSTER_TOLERANCE) {
        current.push(tx);
        continue;
      }
    }
    clusters.push([tx]);
  }

  return clusters;
}

function classifyFrequency(
  dates: string[],
): { frequency: PaymentFrequency; gapCV: number } | null {
  const sorted = [...dates].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1]!, sorted[i]!));

  const meanGap = mean(gaps);
  if (meanGap === 0) return null; // same-day duplicates are not a cadence

  const gapCV = stddev(gaps, meanGap) / meanGap;
  if (gapCV > INTERVAL_REGULARITY_CV_CAP) return null;

  let best: PaymentFrequency | null = null;
  let bestDeviation = Infinity;
  for (const [freq, target] of Object.entries(FREQUENCY_TARGET_DAYS) as [PaymentFrequency, number][]) {
    const deviation = Math.abs(meanGap - target) / target;
    if (deviation < bestDeviation) {
      bestDeviation = deviation;
      best = freq;
    }
  }
  if (!best || bestDeviation > FREQUENCY_MATCH_TOLERANCE) return null;

  return { frequency: best, gapCV };
}

/**
 * Weighted blend of three independent signals, each already in [0,1]:
 * interval regularity (45%), amount consistency (35%), sample size (20%).
 * Interval carries the most weight because irregular timing is this
 * detector's hard gate everywhere else too — a cluster that barely
 * qualifies should score lower than one that is metronomic. Amount
 * consistency is weighted below it deliberately: real recurring bills
 * (utilities, usage-based subscriptions) legitimately vary in amount while
 * still being the same recurring relationship, so this factor penalises
 * inconsistency without being able to veto a detection on its own.
 */
function confidenceScore(gapCV: number, amountCV: number, occurrences: number): number {
  const intervalScore = clamp01(1 - gapCV / INTERVAL_REGULARITY_CV_CAP);
  const amountScore = clamp01(1 - amountCV / AMOUNT_CLUSTER_TOLERANCE);
  const occurrenceScore = clamp01((occurrences - 1) / 6); // saturates at 7 occurrences
  return clamp01(0.45 * intervalScore + 0.35 * amountScore + 0.2 * occurrenceScore);
}

/**
 * Detects recurring payments in a customer's transaction history.
 *
 * Grouping key is (account, direction, normalised counterparty) so an
 * inbound salary and an outbound transfer to the same name never merge, and
 * a pattern on one account is never blended with another. Within a group,
 * amounts are sub-clustered (see `clusterByAmount`) before interval
 * regularity is checked, so a merchant with both a fixed subscription and
 * unrelated one-off purchases only has the subscription flagged.
 *
 * Category: every detection defaults to `OTHER`. The one exception is
 * `SALARY` — the largest-amount inbound monthly cluster on an account is
 * tagged `SALARY`, a narrow, well-established heuristic in account
 * aggregation ("the biggest regular monthly deposit is almost always the
 * paycheck"), not a general classifier. `RENT`, `UTILITIES`, `TELECOM`,
 * `SUBSCRIPTION`, `INSURANCE`, `TAX`, `LOAN_REPAYMENT` are not attempted:
 * that needs either a merchant-name taxonomy (not built) or a provider's
 * own category feed mapped against a confirmed schema (Powens' `categories`
 * field looked promising during research but its exact taxonomy is not
 * documented anywhere this file could verify — see powens.ts's transaction
 * mapping caveats). Leaving these `OTHER` rather than guessing is the same
 * choice this repo already made for Powens' ambiguous account types.
 */
export function detectRecurringPayments(transactions: Transaction[]): RecurringPayment[] {
  const groups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const key = `${tx.accountId}|${tx.direction}|${normalizeCounterparty(tx.counterpartyLabel)}`;
    const list = groups.get(key);
    if (list) list.push(tx);
    else groups.set(key, [tx]);
  }

  type Draft = Omit<RecurringPayment, 'id' | 'migrationStatus'>;
  const drafts: Draft[] = [];

  for (const group of groups.values()) {
    for (const cluster of clusterByAmount(group)) {
      if (cluster.length < MIN_OCCURRENCES) continue;

      const classified = classifyFrequency(cluster.map((t) => t.date));
      if (!classified) continue;

      const amounts = cluster.map((t) => Math.abs(t.amount.amount));
      const amountMean = mean(amounts);
      const amountCV = amountMean > 0 ? stddev(amounts, amountMean) / amountMean : 0;
      const sortedAmounts = [...amounts].sort((a, b) => a - b);
      const medianAmount = sortedAmounts[Math.floor(sortedAmounts.length / 2)]!;

      const sample = cluster[0]!;
      drafts.push({
        customerId: sample.customerId,
        accountId: sample.accountId,
        merchant: sample.counterpartyLabel,
        amount: { amount: medianAmount, currency: sample.amount.currency },
        frequency: classified.frequency,
        category: 'OTHER',
        direction: sample.direction,
        confidence: confidenceScore(classified.gapCV, amountCV, cluster.length),
      });
    }
  }

  // The one category heuristic this detector makes: per account, the
  // largest inbound monthly cluster is the paycheck.
  const byAccount = new Map<string, Draft[]>();
  for (const d of drafts) {
    const list = byAccount.get(d.accountId);
    if (list) list.push(d);
    else byAccount.set(d.accountId, [d]);
  }
  for (const list of byAccount.values()) {
    const salaryCandidates = list.filter((d) => d.direction === 'INBOUND' && d.frequency === 'MONTHLY');
    if (salaryCandidates.length === 0) continue;
    salaryCandidates.sort((a, b) => b.amount.amount - a.amount.amount);
    salaryCandidates[0]!.category = 'SALARY';
  }

  return drafts
    .sort((a, b) => b.confidence - a.confidence || a.accountId.localeCompare(b.accountId))
    .map((d, i) => ({
      ...d,
      id: `${d.accountId}_rec${i}`,
      migrationStatus: 'NOT_STARTED' as const,
    }));
}
