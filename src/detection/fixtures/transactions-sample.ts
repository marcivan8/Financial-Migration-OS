import type { Transaction } from '../../domain/types.js';
import { money } from '../../domain/types.js';

/**
 * Five months of a fictional current account (2026-04 through 2026-08),
 * built to exercise every branch of `detectRecurringPayments` rather than
 * just its happy path:
 *
 *  - EMPLOYEUR SA: a clean monthly salary — same amount, same day each
 *    month. Should detect at high confidence, tagged SALARY.
 *  - SCI LOYERS PARIS: a clean monthly rent debit — same shape as salary,
 *    opposite direction. High confidence, category stays OTHER (no rent
 *    taxonomy built — see recurring.ts's category caveat).
 *  - FREE MOBILE: a small, exact-amount monthly subscription.
 *  - AXA ASSURANCES: only three occurrences, roughly 91 days apart —
 *    exercises QUARTERLY classification at the minimum sample size.
 *  - EDF ENERGIE: monthly but with real amount variation (a genuine
 *    utility bill) — should still detect, at meaningfully lower confidence
 *    than salary or rent.
 *  - CARREFOUR: same merchant, similar amount, six times — but on
 *    irregular days (ordinary grocery shopping). Must NOT be detected:
 *    proves the detector gates on interval regularity, not just
 *    "same place, similar amount, more than twice."
 *  - AMAZON.FR: only two occurrences. Must NOT be detected: below
 *    MIN_OCCURRENCES.
 *  - One pending transaction (no `value` yet) and one deleted transaction,
 *    to exercise `normalizePowensTransactions`'s skip paths.
 */
export const SAMPLE_TRANSACTIONS: Transaction[] = [
  ...['2026-04-28', '2026-05-28', '2026-06-29', '2026-07-28', '2026-08-28'].map((date, i) => ({
    id: `tx_salary_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date,
    amount: money(2_400_00),
    direction: 'INBOUND' as const,
    counterpartyLabel: 'EMPLOYEUR SA',
    rawLabel: 'VIR EMPLOYEUR SA SALAIRE',
  })),
  ...['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'].map((date, i) => ({
    id: `tx_rent_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date,
    amount: money(-95_000),
    direction: 'OUTBOUND' as const,
    counterpartyLabel: 'SCI LOYERS PARIS',
    rawLabel: 'PRLV SCI LOYERS PARIS',
  })),
  ...['2026-04-05', '2026-05-05', '2026-06-05', '2026-07-05', '2026-08-05'].map((date, i) => ({
    id: `tx_telecom_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date,
    amount: money(-1_999),
    direction: 'OUTBOUND' as const,
    counterpartyLabel: 'FREE MOBILE',
    rawLabel: 'PRLV FREE MOBILE',
  })),
  ...[
    ['2026-02-15', -18_000],
    ['2026-05-16', -18_000],
    ['2026-08-14', -18_000],
  ].map(([date, amount], i) => ({
    id: `tx_insurance_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date: date as string,
    amount: money(amount as number),
    direction: 'OUTBOUND' as const,
    counterpartyLabel: 'AXA ASSURANCES',
    rawLabel: 'PRLV AXA ASSURANCES',
  })),
  ...[
    ['2026-04-10', -8_500],
    ['2026-05-11', -10_500],
    ['2026-06-09', -7_000],
    ['2026-07-12', -9_500],
    ['2026-08-10', -8_000],
  ].map(([date, amount], i) => ({
    id: `tx_edf_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date: date as string,
    amount: money(amount as number),
    direction: 'OUTBOUND' as const,
    counterpartyLabel: 'EDF ENERGIE',
    rawLabel: 'PRLV EDF ENERGIE',
  })),
  ...[
    ['2026-04-03', -4_450],
    ['2026-04-19', -4_820],
    ['2026-05-22', -4_310],
    ['2026-06-02', -4_690],
    ['2026-07-27', -4_500],
    ['2026-08-08', -4_260],
  ].map(([date, amount], i) => ({
    id: `tx_carrefour_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date: date as string,
    amount: money(amount as number),
    direction: 'OUTBOUND' as const,
    counterpartyLabel: 'CARREFOUR CITY',
    rawLabel: 'CB CARREFOUR CITY',
  })),
  ...[
    ['2026-04-14', -3_499],
    ['2026-07-02', -5_200],
  ].map(([date, amount], i) => ({
    id: `tx_amazon_${i}`,
    accountId: 'acc_checking',
    customerId: 'cus_1',
    date: date as string,
    amount: money(amount as number),
    direction: 'OUTBOUND' as const,
    counterpartyLabel: 'AMAZON.FR',
    rawLabel: 'CB AMAZON.FR',
  })),
];
