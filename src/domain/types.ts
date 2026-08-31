/**
 * Canonical financial data model.
 *
 * Nothing in this file is provider-specific. Powens / Tink / TrueLayer payloads
 * are normalised into these shapes by the connectivity layer; everything above
 * this line in the stack only ever sees canonical types.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type CountryCode = 'FR' | 'BE' | 'LU' | 'DE' | 'ES' | 'IT';
export type CurrencyCode = 'EUR' | 'USD' | 'GBP' | 'CHF';

/** Amounts are minor units (cents). Never floats — this is money. */
export type Minor = number;

export interface Money {
  amount: Minor;
  currency: CurrencyCode;
}

export const money = (amount: Minor, currency: CurrencyCode = 'EUR'): Money => ({
  amount,
  currency,
});

// ---------------------------------------------------------------------------
// Institutions
// ---------------------------------------------------------------------------

export type InstitutionType =
  | 'BANK'
  | 'NEOBANK'
  | 'BROKER'
  | 'INSURER'
  | 'PAYMENT_INSTITUTION';

/**
 * What an institution can actually do. The planner reads these before it
 * promises a customer that a product can land at the destination.
 */
export interface InstitutionCapabilities {
  /** Product types this institution is able to open / hold. */
  supportedProducts: ProductType[];
  /** Participates in the French "mobilité bancaire" (Loi Macron) scheme. */
  supportsBankMobilityScheme: boolean;
  /** Can receive an institution-to-institution securities transfer. */
  supportsSecuritiesTransferIn: boolean;
  /** Exposes a machine API for account opening / status. */
  hasApi: boolean;
}

export interface Institution {
  id: string;
  name: string;
  country: CountryCode;
  type: InstitutionType;
  /** Bank identifier (BIC) where relevant — used for transfer instructions. */
  bic?: string;
  capabilities: InstitutionCapabilities;
}

// ---------------------------------------------------------------------------
// Customer & consent
// ---------------------------------------------------------------------------

export interface CustomerIdentity {
  firstName: string;
  lastName: string;
  /** ISO date. Drives age-gated products (e.g. LEP eligibility checks). */
  dateOfBirth: string;
  countryOfResidence: CountryCode;
  /** Fiscal residence drives PEA / assurance-vie treatment. */
  fiscalResidence: CountryCode;
}

export type ConsentScope =
  | 'ACCOUNT_INFORMATION'
  | 'TRANSACTION_HISTORY'
  | 'MIGRATION_EXECUTION';

export interface Consent {
  id: string;
  scopes: ConsentScope[];
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface Customer {
  id: string;
  tenantId: string;
  institutionId: string;
  identity: CustomerIdentity;
  consent: Consent;
  migrationIds: string[];
}

// ---------------------------------------------------------------------------
// Accounts & products
// ---------------------------------------------------------------------------

export type ProductType =
  | 'CURRENT_ACCOUNT'
  | 'LIVRET_A'
  | 'LDDS'
  | 'LEP'
  | 'PEL'
  | 'CEL'
  | 'PEA'
  | 'CTO'
  | 'ASSURANCE_VIE'
  | 'LOAN'
  | 'MORTGAGE'
  | 'CREDIT_CARD'
  | 'INSURANCE';

/**
 * The relationship category a product belongs to. This — not the account —
 * is what the completion score is computed over, because the north-star metric
 * is "did the customer's financial relationship move", not "was an account opened".
 */
export type RelationshipCategory =
  | 'BANKING'
  | 'SAVINGS'
  | 'INVESTMENTS'
  | 'INSURANCE'
  | 'CREDIT'
  | 'INCOME'
  | 'DIRECT_DEBITS';

export const PRODUCT_CATEGORY: Record<ProductType, RelationshipCategory> = {
  CURRENT_ACCOUNT: 'BANKING',
  LIVRET_A: 'SAVINGS',
  LDDS: 'SAVINGS',
  LEP: 'SAVINGS',
  PEL: 'SAVINGS',
  CEL: 'SAVINGS',
  PEA: 'INVESTMENTS',
  CTO: 'INVESTMENTS',
  ASSURANCE_VIE: 'INSURANCE',
  LOAN: 'CREDIT',
  MORTGAGE: 'CREDIT',
  CREDIT_CARD: 'CREDIT',
  INSURANCE: 'INSURANCE',
};

export type AccountStatus = 'ACTIVE' | 'DORMANT' | 'CLOSING' | 'CLOSED';

export interface FinancialAccount {
  id: string;
  customerId: string;
  institutionId: string;
  type: ProductType;
  currency: CurrencyCode;
  balance: Money;
  status: AccountStatus;
  iban?: string;
}

export interface FinancialProduct {
  id: string;
  accountId: string;
  customerId: string;
  institutionId: string;
  type: ProductType;
  /** Raw label as returned by the origin institution, kept for audit. */
  rawLabel: string;
  balance: Money;
  openedAt: string;
  /** Set by the rules engine, never by the connectivity layer. */
  transferable?: boolean;
  metadata: ProductMetadata;
}

/**
 * Product-specific facts the rules engine needs. Deliberately flat and
 * optional: the connectivity layer fills in what it can, and a missing field
 * becomes an explicit exception rather than a silent assumption.
 */
export interface ProductMetadata {
  /** PEA / PEL / CEL: opening date drives tax seniority — must be preserved. */
  fiscalSeniorityDate?: string;
  /** PEA: cumulative payments made, needed to preserve the ceiling calculation. */
  cumulativePayments?: Money;
  /** CTO / PEA: number of distinct lines to transfer. */
  securitiesLineCount?: number;
  /** Assurance-vie: the insurer, which is usually not the distributing bank. */
  underwriterName?: string;
  /** Loans / mortgages: outstanding principal. */
  outstandingPrincipal?: Money;
  /** Whether the origin institution charges a transfer fee. */
  knownTransferFee?: Money;
}

// ---------------------------------------------------------------------------
// Recurring payments — the relationships around the account
// ---------------------------------------------------------------------------

export type PaymentDirection = 'INBOUND' | 'OUTBOUND';
export type PaymentFrequency = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

export type PaymentCategory =
  | 'SALARY'
  | 'RENT'
  | 'UTILITIES'
  | 'TELECOM'
  | 'SUBSCRIPTION'
  | 'INSURANCE'
  | 'TAX'
  | 'LOAN_REPAYMENT'
  | 'OTHER';

export type PaymentMigrationStatus =
  | 'NOT_STARTED'
  | 'NOTIFIED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'NOT_APPLICABLE';

export interface RecurringPayment {
  id: string;
  customerId: string;
  accountId: string;
  merchant: string;
  amount: Money;
  frequency: PaymentFrequency;
  category: PaymentCategory;
  direction: PaymentDirection;
  /** Detection confidence 0..1 — below the threshold it needs human review. */
  confidence: number;
  migrationStatus: PaymentMigrationStatus;
}

// ---------------------------------------------------------------------------
// Migration snapshot — the input to the engine
// ---------------------------------------------------------------------------

export interface MigrationInput {
  tenantId: string;
  customer: Customer;
  origin: Institution;
  destination: Institution;
  products: FinancialProduct[];
  recurringPayments: RecurringPayment[];
}
