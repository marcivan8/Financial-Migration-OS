import type { CountryCode, Money, ProductMetadata, ProductType } from '../domain/types.js';
import type { MigrationAction, TaskType, DocumentRequirement } from '../domain/migration.js';

/**
 * ---------------------------------------------------------------------------
 * FRENCH MIGRATION RULE CATALOG
 * ---------------------------------------------------------------------------
 *
 * This is the deterministic core of the product. No model, no heuristic, no
 * inference: a product type plus a jurisdiction plus institution capabilities
 * resolves to exactly one rule, and that rule is the sole authority on whether
 * something can move and how.
 *
 * ⚠️ LEGAL STATUS — READ BEFORE PRODUCTION
 * The rules below encode the author's reading of French retail-finance practice
 * and are correct enough to build and test the engine against. They are NOT a
 * legal opinion. Every `legalBasis` entry must be validated by counsel, and the
 * fee caps are indexed to INSEE CPI (revised every three years), so they need a
 * maintenance owner. See §26 of the build brief.
 *
 * Verified while writing (2026-08):
 *  - PEA transfer fees: 15 €/listed line, 50 €/unlisted line, 150 € cap per
 *    plan. Décret n° 2020-95 du 5 février 2020 (loi PACTE), art. D. 221-109 CMF.
 *  - Mobilité bancaire: 22 business days for the destination bank to complete
 *    the switch; the origin bank redirects inbound transfers for 13 months;
 *    the service is free. Regulated savings (Livret A, LDDS, PEL, CEL),
 *    assurance-vie and PEA are explicitly OUT of scope of the mandate.
 */

export interface FeeCap {
  perListedLine?: Money;
  perUnlistedLine?: Money;
  total?: Money;
}

export interface MigrationRule {
  id: string;
  productType: ProductType;
  country: CountryCode;
  action: MigrationAction;

  /** Human-readable justification, surfaced to ops and to the customer. */
  rationale: string;
  legalBasis: string;

  /** Does the destination institution have to support the product type? */
  requiresDestinationSupport: boolean;
  /** Does the destination have to accept securities transfers in? */
  requiresSecuritiesTransferIn: boolean;
  /** Is the origin product closed as part of the migration? */
  requiresClosure: boolean;
  /** Can value move institution-to-institution without being liquidated? */
  directTransfer: boolean;
  /** Does the customer keep the fiscal seniority of the original contract? */
  preservesTaxHistory: boolean;

  /**
   * True when a customer may legally hold only one of these across all French
   * institutions — which forces close-before-open ordering rather than the
   * safer open-before-close.
   */
  uniquePerHolder: boolean;

  feeCap?: FeeCap;
  estimatedDurationDays: number;

  /**
   * Metadata the destination institution genuinely needs before this product
   * can settle. Missing entries become explicit exceptions rather than silent
   * assumptions — which is the whole difference between "we transferred an
   * account" and "we transferred an account the customer can still be taxed
   * correctly on".
   */
  requiredMetadata: {
    field: keyof ProductMetadata;
    severity: 'WARNING' | 'INFO';
    /** Why the destination needs it, in words an operator can act on. */
    reason: string;
  }[];

  /** Ordered task template. The planner expands this into a dependency chain. */
  taskTemplate: TaskType[];
  documents: DocumentRequirement[];
}

const doc = (
  code: string,
  label: string,
  providedBy: DocumentRequirement['providedBy'],
  mandatory = true,
): DocumentRequirement => ({ code, label, providedBy, mandatory });

const eur = (amount: number): Money => ({ amount, currency: 'EUR' });

// ---------------------------------------------------------------------------

export const FR_RULES: MigrationRule[] = [
  // -------------------------------------------------------------------------
  // Current account — the only product with a statutory switching service.
  // -------------------------------------------------------------------------
  {
    id: 'FR.CURRENT_ACCOUNT.MOBILITY.v1',
    productType: 'CURRENT_ACCOUNT',
    country: 'FR',
    action: 'AUTOMATED_MOBILITY',
    rationale:
      'The destination bank runs the statutory bank-mobility mandate: it opens the account, ' +
      'notifies every direct-debit issuer and standing-transfer originator, and the origin bank ' +
      'redirects inbound transfers for 13 months.',
    legalBasis:
      'Loi n° 2015-990 (loi Macron), art. L. 312-1-7 CMF — service d’aide à la mobilité bancaire',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: true,
    directTransfer: true,
    preservesTaxHistory: false,
    uniquePerHolder: false,
    estimatedDurationDays: 22,
    requiredMetadata: [],
    taskTemplate: [
      'OPEN_DESTINATION_PRODUCT',
      'AWAIT_ACCOUNT_CONFIRMATION',
      'TRIGGER_MOBILITY_MANDATE',
      'TRANSFER_BALANCE',
      'CLOSE_ORIGIN_PRODUCT',
      'VERIFY_BALANCE',
    ],
    documents: [
      doc('ID_PROOF', 'Pièce d’identité en cours de validité', 'CUSTOMER'),
      doc('PROOF_OF_ADDRESS', 'Justificatif de domicile (< 3 mois)', 'CUSTOMER'),
      doc('MOBILITY_MANDATE', 'Mandat de mobilité bancaire signé', 'CUSTOMER'),
      doc('ORIGIN_RIB', 'RIB du compte d’origine', 'ORIGIN_INSTITUTION'),
    ],
  },

  // -------------------------------------------------------------------------
  // Regulated savings — one per holder, so they cannot be transferred and the
  // old one MUST close before the new one opens.
  // -------------------------------------------------------------------------
  {
    id: 'FR.LIVRET_A.CLOSE_REOPEN.v1',
    productType: 'LIVRET_A',
    country: 'FR',
    action: 'CLOSE_AND_REOPEN',
    rationale:
      'A Livret A cannot be transferred between institutions and a holder may own only one ' +
      'nationwide. The origin livret must be closed and the balance swept before the destination ' +
      'can open a new one; interest is settled by quinzaine, so timing the closure matters.',
    legalBasis: 'Art. L. 221-1 et s. CMF — unicité du Livret A',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: true,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: true,
    estimatedDurationDays: 20,
    requiredMetadata: [],
    taskTemplate: [
      'CLOSE_ORIGIN_PRODUCT',
      'OPEN_DESTINATION_PRODUCT',
      'AWAIT_ACCOUNT_CONFIRMATION',
      'TRANSFER_BALANCE',
      'VERIFY_BALANCE',
    ],
    documents: [
      doc('CLOSURE_REQUEST', 'Demande de clôture du Livret A d’origine', 'CUSTOMER'),
      doc('CLOSURE_STATEMENT', 'Attestation de clôture', 'ORIGIN_INSTITUTION'),
      doc('TAX_ID', 'Numéro fiscal (contrôle d’unicité)', 'CUSTOMER'),
    ],
  },
  {
    id: 'FR.LDDS.CLOSE_REOPEN.v1',
    productType: 'LDDS',
    country: 'FR',
    action: 'CLOSE_AND_REOPEN',
    rationale:
      'Same regime as the Livret A: no inter-bank transfer exists, one per holder, so the ' +
      'origin account is closed and the balance swept into the new one.',
    legalBasis: 'Art. L. 221-27 CMF — unicité du LDDS',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: true,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: true,
    estimatedDurationDays: 20,
    requiredMetadata: [],
    taskTemplate: [
      'CLOSE_ORIGIN_PRODUCT',
      'OPEN_DESTINATION_PRODUCT',
      'AWAIT_ACCOUNT_CONFIRMATION',
      'TRANSFER_BALANCE',
      'VERIFY_BALANCE',
    ],
    documents: [
      doc('CLOSURE_REQUEST', 'Demande de clôture du LDDS d’origine', 'CUSTOMER'),
      doc('CLOSURE_STATEMENT', 'Attestation de clôture', 'ORIGIN_INSTITUTION'),
      doc('TAX_ID', 'Numéro fiscal (contrôle d’unicité)', 'CUSTOMER'),
    ],
  },
  {
    id: 'FR.LEP.CLOSE_REOPEN.v1',
    productType: 'LEP',
    country: 'FR',
    action: 'MANUAL_REVIEW',
    rationale:
      'The LEP is means-tested and re-checked against the tax administration each year. ' +
      'Eligibility at the destination cannot be assumed from the origin holding, so an operator ' +
      'must confirm the customer still qualifies before anything is closed.',
    legalBasis: 'Art. L. 221-13 CMF — conditions de ressources',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: true,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: true,
    estimatedDurationDays: 30,
    requiredMetadata: [],
    taskTemplate: ['MANUAL_REVIEW', 'COLLECT_DOCUMENT'],
    documents: [doc('TAX_NOTICE', 'Avis d’imposition (contrôle de ressources)', 'CUSTOMER')],
  },

  // -------------------------------------------------------------------------
  // Securities — real institution-to-institution transfers, fiscal seniority
  // preserved, and the only products with statutory fee caps.
  // -------------------------------------------------------------------------
  {
    id: 'FR.PEA.TRANSFER.v1',
    productType: 'PEA',
    country: 'FR',
    action: 'INSTITUTION_TRANSFER',
    rationale:
      'A PEA transfers institution-to-institution and keeps its opening date, which is what ' +
      'drives the 5-year tax threshold. Cumulative payments must travel with it so the ceiling ' +
      'is computed correctly at the destination. Never close and reopen — that destroys the ' +
      'fiscal seniority the customer has been accruing.',
    legalBasis:
      'Art. L. 221-30 et s. CMF; frais plafonnés par décret n° 2020-95 du 5 février 2020 ' +
      '(art. D. 221-109 CMF)',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: true,
    requiresClosure: false,
    directTransfer: true,
    preservesTaxHistory: true,
    uniquePerHolder: true,
    feeCap: {
      perListedLine: eur(1500),
      perUnlistedLine: eur(5000),
      total: eur(15000),
    },
    estimatedDurationDays: 45,
    requiredMetadata: [
      {
        field: 'fiscalSeniorityDate',
        severity: 'WARNING',
        reason:
          'The opening date is what proves the plan has passed the 5-year threshold. Without the ' +
          'attestation d’antériorité fiscale the destination restarts the clock and the customer ' +
          'silently loses years of accrued tax benefit.',
      },
      {
        field: 'cumulativePayments',
        severity: 'WARNING',
        reason:
          'Cumulative payments must travel with the plan so the destination can enforce the ' +
          'statutory ceiling. Missing, the customer can be allowed to over-contribute.',
      },
      {
        field: 'securitiesLineCount',
        severity: 'INFO',
        reason:
          'Line count drives the capped per-line transfer fee; without it the fee quoted to the ' +
          'customer is a guess.',
      },
    ],
    taskTemplate: [
      'OPEN_DESTINATION_PRODUCT',
      'AWAIT_ACCOUNT_CONFIRMATION',
      'REQUEST_INSTITUTION_TRANSFER',
      'AWAIT_TRANSFER_SETTLEMENT',
      'VERIFY_BALANCE',
    ],
    documents: [
      doc('TRANSFER_MANDATE', 'Demande de transfert de PEA signée', 'CUSTOMER'),
      doc('PEA_SENIORITY_CERT', 'Attestation d’antériorité fiscale du PEA', 'ORIGIN_INSTITUTION'),
      doc('PEA_PAYMENTS_STATEMENT', 'État des versements cumulés', 'ORIGIN_INSTITUTION'),
      doc('SECURITIES_INVENTORY', 'Inventaire des titres et prix de revient', 'ORIGIN_INSTITUTION'),
    ],
  },
  {
    id: 'FR.CTO.TRANSFER.v1',
    productType: 'CTO',
    country: 'FR',
    action: 'INSTITUTION_TRANSFER',
    rationale:
      'An ordinary securities account transfers in kind, which avoids realising capital gains. ' +
      'The acquisition prices (prix de revient) must be transmitted with the positions, ' +
      'otherwise the destination cannot compute the customer’s future tax base.',
    legalBasis: 'Transfert de titres en compte — pas de fait générateur d’imposition',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: true,
    requiresClosure: false,
    directTransfer: true,
    preservesTaxHistory: true,
    uniquePerHolder: false,
    estimatedDurationDays: 30,
    requiredMetadata: [
      {
        field: 'securitiesLineCount',
        severity: 'WARNING',
        reason:
          'The destination needs the positions inventory, including acquisition prices (prix de ' +
          'revient), or it cannot compute the customer’s future capital-gains base. A CTO has no ' +
          'fiscal seniority to preserve — the cost basis is the thing that must survive the move.',
      },
    ],
    taskTemplate: [
      'OPEN_DESTINATION_PRODUCT',
      'AWAIT_ACCOUNT_CONFIRMATION',
      'REQUEST_INSTITUTION_TRANSFER',
      'AWAIT_TRANSFER_SETTLEMENT',
      'VERIFY_BALANCE',
    ],
    documents: [
      doc('TRANSFER_MANDATE', 'Demande de transfert de compte-titres signée', 'CUSTOMER'),
      doc('SECURITIES_INVENTORY', 'Inventaire des titres et prix de revient', 'ORIGIN_INSTITUTION'),
    ],
  },

  // -------------------------------------------------------------------------
  // Out of MVP scope — modelled explicitly so the plan says WHY, rather than
  // silently dropping half the customer's financial life.
  // -------------------------------------------------------------------------
  {
    id: 'FR.ASSURANCE_VIE.KEEP.v1',
    productType: 'ASSURANCE_VIE',
    country: 'FR',
    action: 'KEEP_AT_ORIGIN',
    rationale:
      'An assurance-vie contract belongs to the insurer, not to the distributing bank, and ' +
      'cannot be moved to a different insurer without surrendering it and losing the fiscal ' +
      'seniority. The contract stays where it is; only the linked payment account changes.',
    legalBasis:
      'Art. 125-0 A CGI (antériorité fiscale); transférabilité limitée au même assureur ' +
      '(loi PACTE, art. 72)',
    requiresDestinationSupport: false,
    requiresSecuritiesTransferIn: false,
    requiresClosure: false,
    directTransfer: false,
    preservesTaxHistory: true,
    uniquePerHolder: false,
    estimatedDurationDays: 10,
    requiredMetadata: [],
    taskTemplate: ['MANUAL_REVIEW', 'NOTIFY_PAYMENT_COUNTERPARTY'],
    documents: [
      doc('CONTRACT_STATEMENT', 'Relevé de situation du contrat', 'ORIGIN_INSTITUTION', false),
    ],
  },
  {
    id: 'FR.PEL.MANUAL.v1',
    productType: 'PEL',
    country: 'FR',
    action: 'MANUAL_REVIEW',
    rationale:
      'A PEL can be transferred between institutions but the destination must be able to hold ' +
      'the generation-specific rate and the associated loan rights. Fee levels vary widely and ' +
      'the arbitrage is customer-specific, so an operator decides.',
    legalBasis: 'Art. R. 315-1 et s. CCH',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: false,
    directTransfer: true,
    preservesTaxHistory: true,
    uniquePerHolder: true,
    estimatedDurationDays: 40,
    requiredMetadata: [],
    taskTemplate: ['MANUAL_REVIEW'],
    documents: [],
  },
  {
    id: 'FR.CEL.MANUAL.v1',
    productType: 'CEL',
    country: 'FR',
    action: 'MANUAL_REVIEW',
    rationale: 'Same regime as the PEL: transferable in principle, operator-decided in practice.',
    legalBasis: 'Art. R. 315-1 et s. CCH',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: false,
    directTransfer: true,
    preservesTaxHistory: true,
    uniquePerHolder: true,
    estimatedDurationDays: 40,
    requiredMetadata: [],
    taskTemplate: ['MANUAL_REVIEW'],
    documents: [],
  },
  {
    id: 'FR.LOAN.KEEP.v1',
    productType: 'LOAN',
    country: 'FR',
    action: 'KEEP_AT_ORIGIN',
    rationale:
      'A consumer loan is a contract with the lending institution. Migration does not move it; ' +
      'only the repayment direct debit is redirected to the new current account.',
    legalBasis: 'Contrat de crédit — pas de transférabilité de plein droit',
    requiresDestinationSupport: false,
    requiresSecuritiesTransferIn: false,
    requiresClosure: false,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: false,
    estimatedDurationDays: 5,
    requiredMetadata: [],
    taskTemplate: ['NOTIFY_PAYMENT_COUNTERPARTY', 'VERIFY_PAYMENT_REDIRECTED'],
    documents: [],
  },
  {
    id: 'FR.MORTGAGE.KEEP.v1',
    productType: 'MORTGAGE',
    country: 'FR',
    action: 'KEEP_AT_ORIGIN',
    rationale:
      'A mortgage stays with the lender. Moving it means a new loan (rachat de crédit), which is ' +
      'a credit decision, not a migration. Only the repayment mandate is redirected.',
    legalBasis: 'Contrat de prêt immobilier — rachat de crédit hors périmètre',
    requiresDestinationSupport: false,
    requiresSecuritiesTransferIn: false,
    requiresClosure: false,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: false,
    estimatedDurationDays: 5,
    requiredMetadata: [],
    taskTemplate: ['NOTIFY_PAYMENT_COUNTERPARTY', 'VERIFY_PAYMENT_REDIRECTED'],
    documents: [],
  },
  {
    id: 'FR.CREDIT_CARD.CLOSE.v1',
    productType: 'CREDIT_CARD',
    country: 'FR',
    action: 'CLOSE_AND_REOPEN',
    rationale:
      'A card is bound to its issuing account. It closes with the origin current account; the ' +
      'destination issues its own. Any card-on-file merchants must be re-registered by the customer.',
    legalBasis: 'Contrat porteur adossé au compte de dépôt',
    requiresDestinationSupport: true,
    requiresSecuritiesTransferIn: false,
    requiresClosure: true,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: false,
    estimatedDurationDays: 15,
    requiredMetadata: [],
    taskTemplate: [
      'OPEN_DESTINATION_PRODUCT',
      'AWAIT_ACCOUNT_CONFIRMATION',
      'CLOSE_ORIGIN_PRODUCT',
    ],
    documents: [],
  },
  {
    id: 'FR.INSURANCE.KEEP.v1',
    productType: 'INSURANCE',
    country: 'FR',
    action: 'KEEP_AT_ORIGIN',
    rationale:
      'A non-life policy is with the insurer and unaffected by the banking move; only its ' +
      'premium direct debit is redirected. Cancelling it is a separate customer decision.',
    legalBasis: 'Contrat d’assurance — résiliation infra-annuelle hors périmètre (loi Hamon)',
    requiresDestinationSupport: false,
    requiresSecuritiesTransferIn: false,
    requiresClosure: false,
    directTransfer: false,
    preservesTaxHistory: false,
    uniquePerHolder: false,
    estimatedDurationDays: 5,
    requiredMetadata: [],
    taskTemplate: ['NOTIFY_PAYMENT_COUNTERPARTY', 'VERIFY_PAYMENT_REDIRECTED'],
    documents: [],
  },
];

/** Product types the MVP claims to handle end-to-end. */
export const MVP_PRODUCTS: ReadonlySet<ProductType> = new Set<ProductType>([
  'CURRENT_ACCOUNT',
  'LIVRET_A',
  'LDDS',
  'PEA',
  'CTO',
]);
