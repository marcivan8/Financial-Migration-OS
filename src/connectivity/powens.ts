import type { FinancialProduct, ProductType, Transaction } from '../domain/types.js';
import type {
  ConnectivityProvider,
  NormalizationResult,
  SkippedAccount,
  TransactionNormalizationResult,
} from './types.js';

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

// ---------------------------------------------------------------------------
// Transactions — feeding recurring-payment detection (src/detection/recurring.ts)
// ---------------------------------------------------------------------------

/**
 * Modeled from Powens' `GET /2.0/users/{userId}/accounts/{accountId}/transactions`
 * reference (docs.powens.com), checked while writing this file — same caveat
 * as the account shape above: documented, not integration-tested live.
 *
 * Two things the docs leave genuinely open, called out rather than guessed:
 *
 * 1. Sign convention. The docs describe `value` as the transaction amount but
 *    do not explicitly confirm "negative = debit" anywhere reachable from the
 *    public reference. This mapping assumes it — it is the near-universal
 *    convention among account-aggregation APIs, and every field name in this
 *    file (`debit`-shaped and `credit`-shaped values sharing one signed field
 *    called `value`) points the same way — but it is an assumption, not a
 *    confirmed fact, and belongs on the list of things to verify against a
 *    live sandbox before this ships, alongside the rest of this file.
 * 2. `id_cluster` ("if the transaction is part of a cluster") looks like it
 *    could be Powens' own recurring-transaction grouping, but the docs do not
 *    describe it as one. Rather than build on an unconfirmed feature, the
 *    detector below (`detectRecurringPayments`) does its own grouping from
 *    counterparty + amount + interval and ignores `id_cluster` entirely. If
 *    `id_cluster` does turn out to be Powens' own recurrence signal, it is a
 *    cross-check to add later, not a foundation to build on now.
 */
export interface PowensTransaction {
  id: number;
  id_account: number;
  /** Booking/posted date, `YYYY-MM-DD`. */
  date: string;
  /** Signed, major units (euros) — see the sign-convention caveat above. Null while a transaction is still pending in some cases. */
  value: number | null;
  original_wording: string;
  simplified_wording: string | null;
  wording: string | null;
  counterparty: { label: string; type: 'creditor' | 'debtor' } | null;
  deleted: string | null;
}

/** Reused from the account mapping — Powens floats major units, this domain is integer minor units. */
function toMinorUnitsSigned(major: number): number {
  return Math.round(major * 100);
}

export function normalizePowensTransactions(
  raw: unknown[],
  ctx: { customerId: string; accountId: string },
): TransactionNormalizationResult {
  const transactions: Transaction[] = [];
  const skipped: TransactionNormalizationResult['skipped'] = [];

  for (const entry of raw) {
    const tx = entry as PowensTransaction;
    const externalId = String(tx.id);

    if (tx.deleted) {
      skipped.push({ externalTransactionId: externalId, reason: 'deleted at the origin' });
      continue;
    }
    if (tx.value === null) {
      skipped.push({ externalTransactionId: externalId, reason: 'no value — still pending at the origin' });
      continue;
    }

    // Fallback chain for "who is this": Powens' own counterparty extraction
    // first (highest quality when present — PSD2 data does not always carry
    // it), then the bank-cleaned label, then the user-editable one, then the
    // raw statement text. Whichever wins is what the detector below groups by.
    const counterpartyLabel =
      tx.counterparty?.label || tx.simplified_wording || tx.wording || tx.original_wording;

    transactions.push({
      id: `${ctx.customerId}_powens_tx_${externalId}`,
      accountId: ctx.accountId,
      customerId: ctx.customerId,
      date: tx.date,
      amount: {
        amount: toMinorUnitsSigned(tx.value),
        currency: 'EUR',
      },
      direction: tx.value < 0 ? 'OUTBOUND' : 'INBOUND',
      counterpartyLabel,
      rawLabel: tx.original_wording,
      sourceProvider: 'powens',
    });
  }

  return { transactions, skipped };
}

export const PowensProvider: ConnectivityProvider = {
  id: 'powens',
  normalizeAccounts: normalizePowensAccounts,
  normalizeTransactions: normalizePowensTransactions,
};
