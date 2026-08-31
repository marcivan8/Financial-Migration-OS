import type { PowensTransaction } from '../powens.js';

/**
 * A small fictional Powens transaction list — three occurrences of a
 * monthly subscription (enough to clear `MIN_OCCURRENCES`), a pending
 * transaction (`value: null`), and a deleted one. Covers the mapping's
 * skip paths; `test/detection.test.ts` covers the detector itself against
 * a larger, canonical-`Transaction` fixture that does not depend on this
 * one provider's raw shape.
 */
export const POWENS_SAMPLE_TRANSACTIONS: PowensTransaction[] = [
  {
    id: 50001,
    id_account: 9001,
    date: '2026-06-05',
    value: -9.99,
    original_wording: 'PRLV NETFLIX.COM',
    simplified_wording: 'Netflix',
    wording: null,
    counterparty: { label: 'Netflix', type: 'creditor' },
    deleted: null,
  },
  {
    id: 50002,
    id_account: 9001,
    date: '2026-07-05',
    value: -9.99,
    original_wording: 'PRLV NETFLIX.COM',
    simplified_wording: 'Netflix',
    wording: null,
    counterparty: { label: 'Netflix', type: 'creditor' },
    deleted: null,
  },
  {
    id: 50003,
    id_account: 9001,
    date: '2026-08-05',
    value: -9.99,
    original_wording: 'PRLV NETFLIX.COM',
    simplified_wording: 'Netflix',
    wording: null,
    counterparty: { label: 'Netflix', type: 'creditor' },
    deleted: null,
  },
  {
    // Still settling at the origin — must be skipped, not treated as €0.
    id: 50004,
    id_account: 9001,
    date: '2026-08-30',
    value: null,
    original_wording: 'CB EN COURS',
    simplified_wording: null,
    wording: null,
    counterparty: null,
    deleted: null,
  },
  {
    // Reversed/removed at the origin.
    id: 50005,
    id_account: 9001,
    date: '2026-08-12',
    value: -40.0,
    original_wording: 'CB ANNULEE',
    simplified_wording: null,
    wording: null,
    counterparty: null,
    deleted: '2026-08-13T00:00:00Z',
  },
];
