import { describe, it, expect } from 'vitest';
import { resolveProduct, detectDuplicateRegulatedProducts, estimateTransferFees, findRule } from '../src/rules/engine.js';
import { FR_RULES } from '../src/rules/catalog.js';
import { ORIGIN_BANK, DESTINATION_BANK, DESTINATION_NO_SECURITIES } from '../src/fixtures/institutions.js';
import { CUSTOMER, PRODUCTS } from '../src/fixtures/customer.js';
import type { FinancialProduct, Customer } from '../src/domain/types.js';
import { money } from '../src/domain/types.js';

const ctx = { customer: CUSTOMER, origin: ORIGIN_BANK, destination: DESTINATION_BANK };
const find = (id: string): FinancialProduct => {
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) throw new Error(`fixture ${id} missing`);
  return p;
};

describe('rule catalog integrity', () => {
  it('has exactly one rule per product type per country', () => {
    const keys = FR_RULES.map((r) => `${r.country}:${r.productType}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every rule a legal basis — an unjustified rule is not shippable', () => {
    for (const r of FR_RULES) {
      expect(r.legalBasis.length, `${r.id} has no legalBasis`).toBeGreaterThan(0);
      expect(r.rationale.length, `${r.id} has no rationale`).toBeGreaterThan(0);
    }
  });

  it('never marks a close-and-reopen product as preserving tax history', () => {
    for (const r of FR_RULES.filter((x) => x.action === 'CLOSE_AND_REOPEN')) {
      expect(r.preservesTaxHistory, `${r.id} claims to preserve tax history while closing`).toBe(false);
    }
  });
});

describe('product resolution', () => {
  it('routes a current account through the statutory mobility mandate', () => {
    const d = resolveProduct(find('prd_01_current'), ctx);
    expect(d.action).toBe('AUTOMATED_MOBILITY');
    expect(d.ruleId).toBe('FR.CURRENT_ACCOUNT.MOBILITY.v1');
  });

  it('closes and reopens a Livret A rather than transferring it', () => {
    const d = resolveProduct(find('prd_02_livreta'), ctx);
    expect(d.action).toBe('CLOSE_AND_REOPEN');
    expect(d.preservesTaxHistory).toBe(false);
  });

  it('transfers a PEA in place and preserves its fiscal seniority', () => {
    const d = resolveProduct(find('prd_04_pea'), ctx);
    expect(d.action).toBe('INSTITUTION_TRANSFER');
    expect(d.preservesTaxHistory).toBe(true);
    // Closing a PEA would destroy the customer's accrued tax benefit.
    expect(d.rule?.requiresClosure).toBe(false);
  });

  it('blocks a product the destination does not offer, and says so', () => {
    const d = resolveProduct(find('prd_07_lep'), ctx);
    expect(d.action).toBe('NOT_MIGRATABLE');
    expect(d.exceptions.map((e) => e.code)).toContain('PRODUCT_NOT_SUPPORTED_AT_DESTINATION');
    expect(d.exceptions.every((e) => e.resolution.length > 0)).toBe(true);
  });

  it('falls back to manual review when the destination cannot receive securities', () => {
    const d = resolveProduct(find('prd_04_pea'), {
      ...ctx,
      destination: { ...DESTINATION_NO_SECURITIES, capabilities: { ...DESTINATION_NO_SECURITIES.capabilities, supportedProducts: ['PEA'] } },
    });
    expect(d.action).toBe('MANUAL_REVIEW');
    expect(d.exceptions.map((e) => e.code)).toContain('DESTINATION_CAPABILITY_MISSING');
  });

  it('keeps assurance-vie at the origin instead of surrendering it', () => {
    const d = resolveProduct(find('prd_06_assvie'), ctx);
    expect(d.action).toBe('KEEP_AT_ORIGIN');
  });

  it('raises a blocking exception when execution consent is missing', () => {
    const withoutConsent: Customer = {
      ...CUSTOMER,
      consent: { ...CUSTOMER.consent, scopes: ['ACCOUNT_INFORMATION'] },
    };
    const d = resolveProduct(find('prd_02_livreta'), { ...ctx, customer: withoutConsent });
    expect(d.exceptions.some((e) => e.code === 'MISSING_CONSENT_SCOPE' && e.severity === 'BLOCKING')).toBe(true);
  });

  it('refuses a PEA for a non-resident rather than guessing the treatment', () => {
    const nonResident: Customer = {
      ...CUSTOMER,
      identity: { ...CUSTOMER.identity, fiscalResidence: 'BE' },
    };
    const d = resolveProduct(find('prd_04_pea'), { ...ctx, customer: nonResident });
    expect(d.action).toBe('MANUAL_REVIEW');
    expect(d.exceptions.map((e) => e.code)).toContain('FISCAL_RESIDENCE_INELIGIBLE');
  });

  it('flags rule-declared metadata that the origin did not supply', () => {
    const d = resolveProduct(find('prd_05_cto'), ctx);
    const missing = d.exceptions.filter((e) => e.code === 'MISSING_PRODUCT_METADATA');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]!.message).toContain('securitiesLineCount');
  });

  it('is deterministic: the same input resolves identically every time', () => {
    const a = resolveProduct(find('prd_04_pea'), ctx);
    const b = resolveProduct(find('prd_04_pea'), ctx);
    expect(a.action).toBe(b.action);
    expect(a.ruleId).toBe(b.ruleId);
    expect(a.estimatedFees).toEqual(b.estimatedFees);
  });
});

describe('PEA transfer fee caps (décret 2020-95)', () => {
  const peaRule = findRule('FR', find('prd_04_pea'))!;

  it('prices 9 listed lines at 15 € each', () => {
    expect(estimateTransferFees(peaRule, find('prd_04_pea'))).toEqual(money(135_00));
  });

  it('never exceeds the 150 € statutory cap however many lines there are', () => {
    const fat: FinancialProduct = {
      ...find('prd_04_pea'),
      metadata: { ...find('prd_04_pea').metadata, securitiesLineCount: 60 },
    };
    // 60 × 15 € = 900 €, capped to 150 €.
    expect(estimateTransferFees(peaRule, fat)).toEqual(money(150_00));
  });

  it('prefers a fee the origin institution actually quoted', () => {
    const quoted: FinancialProduct = {
      ...find('prd_04_pea'),
      metadata: { ...find('prd_04_pea').metadata, knownTransferFee: money(80_00) },
    };
    expect(estimateTransferFees(peaRule, quoted)).toEqual(money(80_00));
  });
});

describe('cross-product compliance', () => {
  it('detects two Livrets A for one holder', () => {
    const dupes = detectDuplicateRegulatedProducts(
      [find('prd_02_livreta'), { ...find('prd_02_livreta'), id: 'prd_09_livreta_bis' }],
      'FR',
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.code).toBe('DUPLICATE_REGULATED_PRODUCT');
    expect(dupes[0]!.severity).toBe('BLOCKING');
  });

  it('does not flag two securities accounts, which are legal', () => {
    const dupes = detectDuplicateRegulatedProducts(
      [find('prd_05_cto'), { ...find('prd_05_cto'), id: 'prd_10_cto_bis' }],
      'FR',
    );
    expect(dupes).toHaveLength(0);
  });
});
