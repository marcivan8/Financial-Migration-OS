import type { FinancialProduct } from '../domain/types.js';

/**
 * The boundary the brief's §5 connectivity abstraction actually means: every
 * provider adapter turns its own raw account shape into canonical
 * `FinancialProduct` values, and nothing above this line — the rules engine,
 * the planner, the API — ever sees a provider-specific field name. Swapping
 * or adding a provider is a new file here, not a change anywhere else.
 *
 * Deliberately narrow. It does not fetch anything itself (no HTTP client, no
 * auth flow) — that varies per provider and per deployment, and it does not
 * belong in something meant to stay pure and testable without a network.
 * `normalizeAccounts` is the part that is actually provider-specific
 * knowledge worth capturing in code: which raw type is which `ProductType`,
 * which fields the provider does and doesn't give you, and what to do when it
 * gives you a shape this engine's domain model has no place for.
 */
export interface ConnectivityProvider {
  readonly id: string;
  normalizeAccounts(
    raw: unknown[],
    ctx: { customerId: string; institutionId: string; fetchedAt?: string },
  ): NormalizationResult;
}

export interface NormalizationResult {
  products: FinancialProduct[];
  /**
   * Accounts the provider returned that this engine's domain model has no
   * place for — an account type outside `ProductType`, or one the mapping
   * can't trust enough to hand to the rules engine. Reported, never dropped
   * silently: an institution migrating a customer needs to know a product
   * existed that the platform couldn't classify, the same way the batch
   * pipeline reports a bad import row rather than swallowing it.
   */
  skipped: SkippedAccount[];
}

export interface SkippedAccount {
  externalAccountId: string;
  rawType: string;
  reason: string;
}
