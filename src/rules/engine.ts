import type {
  CountryCode,
  FinancialProduct,
  Institution,
  Customer,
  Money,
} from '../domain/types.js';
import type {
  MigrationAction,
  MigrationException,
  ExceptionCode,
  ExceptionSeverity,
} from '../domain/migration.js';
import { FR_RULES, MVP_PRODUCTS, type MigrationRule } from './catalog.js';

/**
 * Rule resolution. Deterministic and total: every product gets an outcome, and
 * an outcome the engine cannot justify is an explicit exception rather than a
 * guess. No language model is consulted anywhere in this file — the AI layer
 * sits *above* this, reading its output.
 */

const RULES_BY_COUNTRY: Map<CountryCode, MigrationRule[]> = new Map([['FR', FR_RULES]]);

export interface RuleContext {
  customer: Customer;
  origin: Institution;
  destination: Institution;
}

export interface RuleDecision {
  rule: MigrationRule | null;
  action: MigrationAction;
  /** Effective, after capability and eligibility checks override the rule. */
  ruleId: string;
  rationale: string;
  preservesTaxHistory: boolean;
  estimatedDurationDays: number;
  estimatedFees: Money;
  exceptions: MigrationException[];
}

/**
 * Ids minted here are LOCAL to one resolution pass — `exc_0001`, `exc_0002`.
 * The planner namespaces them by migration id before they leave the engine
 * (see `namespaceExceptionIds` in planner.ts), because these become primary
 * keys in `migration_exceptions` and get quoted in support tickets. A bare
 * per-plan counter across a 500,000-customer batch mints `exc_0001` half a
 * million times: a primary-key violation in Postgres, and a silent overwrite of
 * one customer's compliance block by another's in any store keyed by id.
 *
 * Keeping the local counter deterministic is what lets two runs of the planner
 * on the same input produce byte-identical plans.
 */
let exceptionCounter = 0;
export const resetExceptionIds = (): void => {
  exceptionCounter = 0;
};

const raise = (
  code: ExceptionCode,
  severity: ExceptionSeverity,
  message: string,
  resolution: string,
  subjectId: string | null,
): MigrationException => ({
  id: `exc_${String(++exceptionCounter).padStart(4, '0')}`,
  code,
  severity,
  message,
  subjectId,
  resolution,
});

const EUR0: Money = { amount: 0, currency: 'EUR' };

/**
 * Statutory fee estimate. For a PEA this is per-line pricing under the
 * caps of décret 2020-95, globally capped at 150 €.
 */
export function estimateTransferFees(
  rule: MigrationRule,
  product: FinancialProduct,
): Money {
  if (product.metadata.knownTransferFee) return product.metadata.knownTransferFee;
  if (!rule.feeCap) return EUR0;

  const lines = product.metadata.securitiesLineCount ?? 0;
  const perLine = rule.feeCap.perListedLine?.amount ?? 0;
  const raw = lines * perLine;
  const cap = rule.feeCap.total?.amount ?? raw;
  return { amount: Math.min(raw, cap), currency: 'EUR' };
}

export function findRule(
  country: CountryCode,
  product: FinancialProduct,
): MigrationRule | null {
  const rules = RULES_BY_COUNTRY.get(country);
  if (!rules) return null;
  return rules.find((r) => r.productType === product.type) ?? null;
}

/**
 * Resolve one product against the catalog and the two institutions.
 *
 * Precedence, highest first:
 *   1. no rule for the jurisdiction/product   → NOT_MIGRATABLE (blocking)
 *   2. missing consent scope                  → NOT_MIGRATABLE (blocking)
 *   3. destination cannot hold the product    → NOT_MIGRATABLE (blocking)
 *   4. destination lacks a needed capability  → MANUAL_REVIEW  (blocking)
 *   5. required metadata absent               → keep action, WARNING
 *   6. otherwise                              → the rule's own action
 */
export function resolveProduct(
  product: FinancialProduct,
  ctx: RuleContext,
): RuleDecision {
  const exceptions: MigrationException[] = [];
  const country = ctx.destination.country;
  const rule = findRule(country, product);

  if (!rule) {
    return {
      rule: null,
      action: 'NOT_MIGRATABLE',
      ruleId: 'NONE',
      rationale:
        `No migration rule exists for ${product.type} in ${country}. The engine will not ` +
        `improvise a procedure for a regulated product.`,
      preservesTaxHistory: false,
      estimatedDurationDays: 0,
      estimatedFees: EUR0,
      exceptions: [
        raise(
          'PRODUCT_NOT_TRANSFERABLE',
          'BLOCKING',
          `Unknown product type ${product.type} for jurisdiction ${country} ("${product.rawLabel}").`,
          'Add a rule to the catalog for this product type, or route the case to operations.',
          product.id,
        ),
      ],
    };
  }

  const needsExecutionConsent =
    rule.action !== 'KEEP_AT_ORIGIN' && rule.action !== 'MANUAL_REVIEW';
  if (needsExecutionConsent && !ctx.customer.consent.scopes.includes('MIGRATION_EXECUTION')) {
    exceptions.push(
      raise(
        'MISSING_CONSENT_SCOPE',
        'BLOCKING',
        'The customer has not granted the MIGRATION_EXECUTION consent scope.',
        'Collect execution consent before any task touching the origin institution is dispatched.',
        product.id,
      ),
    );
  }

  if (
    rule.requiresDestinationSupport &&
    !ctx.destination.capabilities.supportedProducts.includes(product.type)
  ) {
    return {
      rule,
      action: 'NOT_MIGRATABLE',
      ruleId: rule.id,
      rationale: `${ctx.destination.name} does not offer ${product.type}, so there is nowhere for this product to land.`,
      preservesTaxHistory: false,
      estimatedDurationDays: 0,
      estimatedFees: EUR0,
      exceptions: [
        ...exceptions,
        raise(
          'PRODUCT_NOT_SUPPORTED_AT_DESTINATION',
          'BLOCKING',
          `${ctx.destination.name} does not support ${product.type}.`,
          `Either keep this product at ${ctx.origin.name} or confirm the destination has since launched it.`,
          product.id,
        ),
      ],
    };
  }

  if (
    rule.requiresSecuritiesTransferIn &&
    !ctx.destination.capabilities.supportsSecuritiesTransferIn
  ) {
    return {
      rule,
      action: 'MANUAL_REVIEW',
      ruleId: rule.id,
      rationale:
        `${ctx.destination.name} holds ${product.type} but has no inbound securities-transfer ` +
        `capability on file, so the transfer cannot be dispatched automatically.`,
      preservesTaxHistory: rule.preservesTaxHistory,
      estimatedDurationDays: rule.estimatedDurationDays,
      estimatedFees: estimateTransferFees(rule, product),
      exceptions: [
        ...exceptions,
        raise(
          'DESTINATION_CAPABILITY_MISSING',
          'BLOCKING',
          `${ctx.destination.name} is not marked as accepting inbound securities transfers.`,
          'Confirm the destination’s transfer-in process with its back office, then re-plan.',
          product.id,
        ),
      ],
    };
  }

  // Rule-declared metadata requirements. Each missing field becomes its own
  // exception naming the field and why the destination needs it — an operator
  // should never have to guess what "incomplete data" meant.
  for (const requirement of rule.requiredMetadata) {
    if (product.metadata[requirement.field] === undefined) {
      exceptions.push(
        raise(
          'MISSING_PRODUCT_METADATA',
          requirement.severity,
          `${product.type} ${product.id}: "${requirement.field}" is missing.`,
          requirement.reason,
          product.id,
        ),
      );
    }
  }

  if (
    product.type === 'PEA' &&
    ctx.customer.identity.fiscalResidence !== 'FR'
  ) {
    return {
      rule,
      action: 'MANUAL_REVIEW',
      ruleId: rule.id,
      rationale:
        'A PEA requires French fiscal residence. The customer’s fiscal residence on file is ' +
        `${ctx.customer.identity.fiscalResidence}, which changes the treatment entirely.`,
      preservesTaxHistory: rule.preservesTaxHistory,
      estimatedDurationDays: rule.estimatedDurationDays,
      estimatedFees: estimateTransferFees(rule, product),
      exceptions: [
        ...exceptions,
        raise(
          'FISCAL_RESIDENCE_INELIGIBLE',
          'BLOCKING',
          `Customer fiscal residence is ${ctx.customer.identity.fiscalResidence}, not FR.`,
          'Refer to tax specialists: a non-resident PEA is normally frozen rather than transferred.',
          product.id,
        ),
      ],
    };
  }

  if (rule.action === 'MANUAL_REVIEW') {
    exceptions.push(
      raise(
        'MANUAL_REVIEW_REQUIRED',
        'WARNING',
        `${product.type} always routes to an operator under rule ${rule.id}.`,
        rule.rationale,
        product.id,
      ),
    );
  }

  return {
    rule,
    action: rule.action,
    ruleId: rule.id,
    rationale: rule.rationale,
    preservesTaxHistory: rule.preservesTaxHistory,
    estimatedDurationDays: rule.estimatedDurationDays,
    estimatedFees: estimateTransferFees(rule, product),
    exceptions,
  };
}

/**
 * Cross-product check: a holder may own only one of certain regulated products
 * nationwide. Two Livrets A in the same snapshot is a data or compliance
 * problem, and it must surface before anything is opened at the destination.
 */
export function detectDuplicateRegulatedProducts(
  products: FinancialProduct[],
  country: CountryCode,
): MigrationException[] {
  const seen = new Map<string, FinancialProduct[]>();
  for (const p of products) {
    const rule = findRule(country, p);
    if (!rule?.uniquePerHolder) continue;
    const bucket = seen.get(p.type) ?? [];
    bucket.push(p);
    seen.set(p.type, bucket);
  }

  const out: MigrationException[] = [];
  for (const [type, bucket] of seen) {
    if (bucket.length > 1) {
      out.push(
        raise(
          'DUPLICATE_REGULATED_PRODUCT',
          'BLOCKING',
          `${bucket.length} ${type} accounts detected for one holder (${bucket
            .map((p) => p.id)
            .join(', ')}), but only one may be held nationwide.`,
          'Reconcile with the origin institution: this is either stale data or an existing compliance breach. ' +
            'Do not open anything at the destination until it is resolved.',
          bucket[0]?.id ?? null,
        ),
      );
    }
  }
  return out;
}

export function isInMvpScope(product: FinancialProduct): boolean {
  return MVP_PRODUCTS.has(product.type);
}
