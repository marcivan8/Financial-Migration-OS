import type { FinancialProduct, ProductType } from '../domain/types.js';
import type { ConnectivityProvider, NormalizationResult, SkippedAccount } from './types.js';

/**
 * Powens (formerly Budget Insight) — a French/EU open banking aggregator.
 * The first provider behind the connectivity abstraction, chosen because its
 * account-type taxonomy already distinguishes the MVP's regulated French
 * products (`livret_a`, `ldds`, `pel`, `cel`, `pea`) rather than lumping them
 * under a generic "savings" — which is exactly the classification work the
 * rules engine needs done *before* a product reaches it.
 *
 * Field names and the account-type enum below are modeled from Powens' public
 * API reference (docs.powens.com, `/2.0/users/{id}/accounts` and the bank
 * account types reference), checked while writing this file — not against a
 * live sandbox. Treat the shape as "documented", not "integration-tested
 * against Powens" — the honest caveat this repo already applies to the rule
 * catalog applies here too.
 */

export type PowensAccountType =
  | 'checking'
  | 'savings'
  | 'card'
  | 'loan'
  | 'deposit'
  | 'market'
  | 'lifeinsurance'
  | 'pea'
  | 'livret_a'
  | 'livret_b'
  | 'ldds'
  | 'pel'
  | 'cel'
  | 'csl'
  | 'pee'
  | 'perco'
  | 'per'
  | 'perp'
  | 'madelin'
  | 'article83'
  | 'capitalisation'
  | 'crowdlending'
  | 'real_estate'
  | 'rsp'
  | 'cat'
  | 'joint'
  | 'unknown';

export interface PowensAccount {
  id: number;
  id_connection: number | null;
  number: string | null;
  original_name: string;
  name: string;
  /** Major units (euros), not cents — Powens does not use minor-unit integers. */
  balance: number | null;
  coming: number | null;
  currency: { id: string } | null;
  iban: string | null;
  type: { id: number; name: PowensAccountType } | null;
  usage: 'PRIV' | 'ORGA' | null;
  last_update: string | null;
  deleted: string | null;
  disabled: boolean;
  error: string | null;
}

/**
 * Only the types this engine's `ProductType` actually models. Everything
 * else — `deposit`, the employee-savings family (`pee`/`perco`/`per`/`perp`/
 * `madelin`/`article83`), `crowdlending`, `real_estate`, `capitalisation`,
 * `rsp`, `cat`, `csl`, `livret_b`, `joint`, `unknown` — is reported as
 * skipped rather than forced into the nearest-looking bucket. `card` maps to
 * `CREDIT_CARD`, `loan` to `LOAN`: Powens does not distinguish a mortgage
 * from any other loan at this type level, so every Powens `loan` account
 * lands as `LOAN` even where it is really a `MORTGAGE` — a real limitation
 * of classifying from `type` alone, not a bug in this map.
 */
const POWENS_TYPE_MAP: Partial<Record<PowensAccountType, ProductType>> = {
  checking: 'CURRENT_ACCOUNT',
  livret_a: 'LIVRET_A',
  ldds: 'LDDS',
  pel: 'PEL',
  cel: 'CEL',
  pea: 'PEA',
  market: 'CTO',
  lifeinsurance: 'ASSURANCE_VIE',
  loan: 'LOAN',
  card: 'CREDIT_CARD',
};

/** Powens balances are floats in major units; this domain's Money is integer minor units. */
const toMinorUnits = (major: number): number => Math.round(major * 100);

export function normalizePowensAccounts(
  raw: unknown[],
  ctx: { customerId: string; institutionId: string; fetchedAt?: string },
): NormalizationResult {
  const products: FinancialProduct[] = [];
  const skipped: SkippedAccount[] = [];
  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();

  for (const entry of raw) {
    const account = entry as PowensAccount;
    const externalId = String(account.id);
    const rawType = account.type?.name ?? 'unknown';

    if (account.deleted || account.disabled) {
      skipped.push({ externalAccountId: externalId, rawType, reason: 'deleted or disabled at the origin' });
      continue;
    }

    const productType = POWENS_TYPE_MAP[rawType];
    if (!productType) {
      // `savings` is deliberately here too: Powens' generic savings type
      // covers everything from a LEP to a plain unregulated livret, and the
      // difference changes which rule applies. Guessing LIVRET_A because
      // it's the common case would be a silent, wrong classification — the
      // kind of bug this file exists to avoid, not commit.
      skipped.push({
        externalAccountId: externalId,
        rawType,
        reason:
          rawType === 'savings'
            ? "Powens' generic \"savings\" type does not distinguish which regulated (or unregulated) product this is — needs a specific type or manual classification, not a guess."
            : `no ${rawType} → ProductType mapping — outside this engine's MVP product set`,
      });
      continue;
    }

    if (account.balance === null) {
      skipped.push({ externalAccountId: externalId, rawType, reason: 'no balance from the origin — cannot plan a transfer blind' });
      continue;
    }

    products.push({
      id: `${ctx.customerId}_powens_${externalId}`,
      accountId: externalId,
      customerId: ctx.customerId,
      institutionId: ctx.institutionId,
      type: productType,
      rawLabel: account.original_name || account.name,
      balance: {
        amount: toMinorUnits(account.balance),
        currency: (account.currency?.id ?? 'EUR') as FinancialProduct['balance']['currency'],
      },
      // Powens' account object does not expose an opening date (confirmed
      // against its docs while writing this) — last_update is a sync
      // timestamp, not the account's real age, and is used here only as a
      // non-null placeholder. It is never used as fiscalSeniorityDate: that
      // field stays unset for every Powens-sourced PEA/PEL/CEL, which routes
      // straight into the rules engine's existing MISSING_PRODUCT_METADATA
      // path (rules/engine.ts) — the connectivity boundary and the rules
      // engine's exception handling compose without new glue code here.
      openedAt: (account.last_update ?? fetchedAt).slice(0, 10),
      metadata: {},
      sourceProvider: 'powens',
      sourceFetchedAt: fetchedAt,
    });
  }

  return { products, skipped };
}

export const PowensProvider: ConnectivityProvider = {
  id: 'powens',
  normalizeAccounts: normalizePowensAccounts,
};
