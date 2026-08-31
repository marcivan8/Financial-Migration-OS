import { describe, it, expect } from 'vitest';
import { detectRecurringPayments } from '../src/detection/recurring.js';
import { SAMPLE_TRANSACTIONS } from '../src/detection/fixtures/transactions-sample.js';
import { RECURRING_CONFIDENCE_THRESHOLD } from '../src/planner/planner.js';

describe('recurring-payment detection', () => {
  const detected = detectRecurringPayments(SAMPLE_TRANSACTIONS);
  const byMerchant = (m: string) => detected.find((p) => p.merchant === m);

  it('detects a clean monthly salary at high confidence and tags it SALARY', () => {
    const salary = byMerchant('EMPLOYEUR SA');
    expect(salary).toBeDefined();
    expect(salary!.direction).toBe('INBOUND');
    expect(salary!.frequency).toBe('MONTHLY');
    expect(salary!.amount).toEqual({ amount: 240_000, currency: 'EUR' });
    expect(salary!.category).toBe('SALARY');
    expect(salary!.confidence).toBeGreaterThanOrEqual(RECURRING_CONFIDENCE_THRESHOLD);
  });

  it('detects a clean monthly rent debit, but does not guess a category for it', () => {
    const rent = byMerchant('SCI LOYERS PARIS');
    expect(rent).toBeDefined();
    expect(rent!.direction).toBe('OUTBOUND');
    expect(rent!.frequency).toBe('MONTHLY');
    expect(rent!.category).toBe('OTHER');
    expect(rent!.confidence).toBeGreaterThanOrEqual(RECURRING_CONFIDENCE_THRESHOLD);
  });

  it('detects a small exact-amount monthly subscription', () => {
    const telecom = byMerchant('FREE MOBILE');
    expect(telecom).toBeDefined();
    expect(telecom!.amount).toEqual({ amount: 1_999, currency: 'EUR' });
    expect(telecom!.frequency).toBe('MONTHLY');
  });

  it('classifies a three-occurrence, ~91-day-apart pattern as QUARTERLY', () => {
    const insurance = byMerchant('AXA ASSURANCES');
    expect(insurance).toBeDefined();
    expect(insurance!.frequency).toBe('QUARTERLY');
  });

  it('still detects a genuinely variable utility bill, at lower confidence than a fixed one', () => {
    const edf = byMerchant('EDF ENERGIE');
    const salary = byMerchant('EMPLOYEUR SA');
    expect(edf).toBeDefined();
    expect(edf!.frequency).toBe('MONTHLY');
    expect(edf!.confidence).toBeLessThan(salary!.confidence);
  });

  it('does not flag irregular same-merchant shopping as a recurring payment', () => {
    // Same store, similar basket size, six times in five months — but on no
    // fixed cadence. This is what most grocery spending looks like, and a
    // detector that flags it isn't measuring recurrence, just repetition.
    expect(byMerchant('CARREFOUR CITY')).toBeUndefined();
  });

  it('does not flag a merchant seen only twice — below the minimum sample size', () => {
    expect(byMerchant('AMAZON.FR')).toBeUndefined();
  });

  it('produces stable, unique ids and defaults every detection to NOT_STARTED', () => {
    const ids = detected.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(detected.every((p) => p.migrationStatus === 'NOT_STARTED')).toBe(true);
  });

  it('every confidence score is a valid probability', () => {
    expect(detected.every((p) => p.confidence >= 0 && p.confidence <= 1)).toBe(true);
  });

  it('is deterministic — the same transactions in produce the same result out', () => {
    expect(detectRecurringPayments(SAMPLE_TRANSACTIONS)).toEqual(detected);
  });
});
