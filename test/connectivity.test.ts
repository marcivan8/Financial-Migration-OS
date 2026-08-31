import { describe, it, expect } from 'vitest';
import { normalizePowensAccounts, PowensProvider } from '../src/connectivity/powens.js';
import { POWENS_SAMPLE_ACCOUNTS } from '../src/connectivity/fixtures/powens-sample.js';
import { resolveProduct } from '../src/rules/engine.js';
import { CUSTOMER } from '../src/fixtures/customer.js';
import { ORIGIN_BANK, DESTINATION_BANK } from '../src/fixtures/institutions.js';

const ctx = { customerId: CUSTOMER.id, institutionId: ORIGIN_BANK.id, fetchedAt: '2026-08-31T00:00:00.000Z' };

describe('Powens connectivity adapter', () => {
  it('maps every account type this engine models, and only those', () => {
    const { products } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    const byType = Object.fromEntries(products.map((p) => [p.type, p]));
    expect(Object.keys(byType).sort()).toEqual(
      ['ASSURANCE_VIE', 'CTO', 'CURRENT_ACCOUNT', 'LIVRET_A', 'LOAN', 'PEA'].sort(),
    );
  });

  it('converts Powens major-unit floats to integer minor units', () => {
    const { products } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    const current = products.find((p) => p.type === 'CURRENT_ACCOUNT')!;
    expect(current.balance).toEqual({ amount: 184255, currency: 'EUR' });
    const livretA = products.find((p) => p.type === 'LIVRET_A')!;
    expect(livretA.balance.amount).toBe(620000);
  });

  it('tags every mapped product with its source provider and fetch time', () => {
    const { products } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    for (const p of products) {
      expect(p.sourceProvider).toBe('powens');
      expect(p.sourceFetchedAt).toBe('2026-08-31T00:00:00.000Z');
    }
  });

  it('skips a deleted account rather than planning a migration for a closed product', () => {
    const { products, skipped } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    expect(products.some((p) => p.accountId === '9009')).toBe(false);
    expect(skipped.find((s) => s.externalAccountId === '9009')?.reason).toMatch(/deleted|disabled/);
  });

  it('refuses to guess which regulated product a generic "savings" account is', () => {
    const { skipped } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    const savings = skipped.find((s) => s.externalAccountId === '9007');
    expect(savings?.rawType).toBe('savings');
    expect(savings?.reason).toMatch(/does not distinguish/);
  });

  it('reports a type outside the MVP product set as skipped, not dropped', () => {
    const { skipped } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    const crowdlending = skipped.find((s) => s.externalAccountId === '9008');
    expect(crowdlending?.rawType).toBe('crowdlending');
    expect(crowdlending?.reason).toMatch(/no crowdlending/);
  });

  it('is registered under a stable provider id', () => {
    expect(PowensProvider.id).toBe('powens');
    expect(PowensProvider.normalizeAccounts).toBe(normalizePowensAccounts);
  });

  it('never fabricates a PEA fiscal seniority date — the rules engine catches the gap instead', () => {
    // This is the composition claim from powens.ts's own comment, checked for
    // real rather than just asserted in prose: a Powens-sourced PEA carries
    // no fiscalSeniorityDate (Powens' account object doesn't expose one), and
    // that has to surface as an exception an operator can act on, not a
    // silently wrong tax-seniority assumption.
    const { products } = normalizePowensAccounts(POWENS_SAMPLE_ACCOUNTS, ctx);
    const pea = products.find((p) => p.type === 'PEA')!;
    expect(pea.metadata.fiscalSeniorityDate).toBeUndefined();

    const decision = resolveProduct(pea, {
      customer: CUSTOMER,
      origin: ORIGIN_BANK,
      destination: DESTINATION_BANK,
    });
    expect(decision.exceptions.some((e) => e.code === 'MISSING_PRODUCT_METADATA')).toBe(true);
  });
});
