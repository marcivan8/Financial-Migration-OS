import type {
  Customer,
  FinancialProduct,
  MigrationInput,
  RecurringPayment,
} from '../domain/types.js';
import { money } from '../domain/types.js';
import { ORIGIN_BANK, DESTINATION_BANK } from './institutions.js';

/**
 * A fictional customer with a realistically messy financial life: five products
 * inside the MVP scope, three outside it, and a spread of recurring payments
 * including one the detector is unsure about.
 *
 * All data is invented. No real person, account or IBAN.
 */

export const CUSTOMER: Customer = {
  id: 'cus_82931',
  tenantId: 'ten_nova',
  institutionId: ORIGIN_BANK.id,
  identity: {
    firstName: 'Camille',
    lastName: 'Dubreuil',
    dateOfBirth: '1989-03-14',
    countryOfResidence: 'FR',
    fiscalResidence: 'FR',
  },
  consent: {
    id: 'con_5512',
    scopes: ['ACCOUNT_INFORMATION', 'TRANSACTION_HISTORY', 'MIGRATION_EXECUTION'],
    grantedAt: '2026-08-20T09:12:00.000Z',
    expiresAt: '2027-08-20T09:12:00.000Z',
  },
  migrationIds: [],
};

const product = (
  p: Omit<FinancialProduct, 'customerId' | 'institutionId' | 'accountId'> &
    Partial<Pick<FinancialProduct, 'accountId'>>,
): FinancialProduct => ({
  customerId: CUSTOMER.id,
  institutionId: ORIGIN_BANK.id,
  accountId: p.accountId ?? `acc_${p.id.slice(4)}`,
  ...p,
});

export const PRODUCTS: FinancialProduct[] = [
  product({
    id: 'prd_01_current',
    type: 'CURRENT_ACCOUNT',
    rawLabel: 'Compte de dépôt Essentiel',
    balance: money(248_37),
    openedAt: '2012-09-03',
    metadata: {},
  }),
  product({
    id: 'prd_02_livreta',
    type: 'LIVRET_A',
    rawLabel: 'Livret A',
    balance: money(8_200_00),
    openedAt: '2012-09-03',
    metadata: {},
  }),
  product({
    id: 'prd_03_ldds',
    type: 'LDDS',
    rawLabel: 'Livret de Développement Durable et Solidaire',
    balance: money(4_512_00),
    openedAt: '2015-06-19',
    metadata: {},
  }),
  product({
    id: 'prd_04_pea',
    type: 'PEA',
    rawLabel: "Plan d'Épargne en Actions",
    balance: money(31_480_00),
    openedAt: '2018-02-11',
    metadata: {
      fiscalSeniorityDate: '2018-02-11',
      cumulativePayments: money(24_000_00),
      securitiesLineCount: 9,
    },
  }),
  product({
    id: 'prd_05_cto',
    type: 'CTO',
    rawLabel: 'Compte-titres ordinaire',
    balance: money(6_940_00),
    openedAt: '2021-11-02',
    // securitiesLineCount deliberately absent → INFO exception, fee unknown.
    metadata: {},
  }),

  // ---- outside MVP scope, kept so the plan tells the truth about them ----
  product({
    id: 'prd_06_assvie',
    type: 'ASSURANCE_VIE',
    rawLabel: 'Contrat Meridienne Avenir',
    balance: money(42_150_00),
    openedAt: '2014-04-28',
    metadata: {
      fiscalSeniorityDate: '2014-04-28',
      underwriterName: 'Meridienne Assurances Vie',
    },
  }),
  product({
    id: 'prd_07_lep',
    type: 'LEP',
    rawLabel: "Livret d'Épargne Populaire",
    balance: money(3_100_00),
    openedAt: '2019-01-15',
    metadata: {},
  }),
  product({
    id: 'prd_08_mortgage',
    type: 'MORTGAGE',
    rawLabel: 'Prêt immobilier résidence principale',
    balance: money(-187_400_00),
    openedAt: '2020-07-01',
    metadata: { outstandingPrincipal: money(187_400_00) },
  }),
];

export const RECURRING_PAYMENTS: RecurringPayment[] = [
  {
    id: 'rec_01_salary',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'Atelier Voltaire SAS',
    amount: money(3_180_00),
    frequency: 'MONTHLY',
    category: 'SALARY',
    direction: 'INBOUND',
    confidence: 0.99,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_02_rent',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'SCI Bellevue',
    amount: money(1_140_00),
    frequency: 'MONTHLY',
    category: 'RENT',
    direction: 'OUTBOUND',
    confidence: 0.97,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_03_energy',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'Fournisseur Énergie Nationale',
    amount: money(94_20),
    frequency: 'MONTHLY',
    category: 'UTILITIES',
    direction: 'OUTBOUND',
    confidence: 0.95,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_04_telecom',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'Télécom Hexagone',
    amount: money(29_99),
    frequency: 'MONTHLY',
    category: 'TELECOM',
    direction: 'OUTBOUND',
    confidence: 0.93,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_05_mortgage',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'Banque Meridienne — échéance prêt',
    amount: money(842_60),
    frequency: 'MONTHLY',
    category: 'LOAN_REPAYMENT',
    direction: 'OUTBOUND',
    confidence: 0.98,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_06_streaming',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'Service de streaming',
    amount: money(13_49),
    frequency: 'MONTHLY',
    category: 'SUBSCRIPTION',
    direction: 'OUTBOUND',
    confidence: 0.88,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_07_gym',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'Salle de sport Quai Sud',
    amount: money(34_90),
    frequency: 'MONTHLY',
    category: 'SUBSCRIPTION',
    direction: 'OUTBOUND',
    // Low confidence on purpose: three debits, irregular amounts. The engine
    // must route this to a human instead of confidently notifying a merchant.
    confidence: 0.52,
    migrationStatus: 'NOT_STARTED',
  },
  {
    id: 'rec_08_tax',
    customerId: CUSTOMER.id,
    accountId: 'acc_01_current',
    merchant: 'DGFiP — prélèvement à la source',
    amount: money(310_00),
    frequency: 'MONTHLY',
    category: 'TAX',
    direction: 'OUTBOUND',
    confidence: 0.99,
    migrationStatus: 'NOT_STARTED',
  },
];

export const DEMO_INPUT: MigrationInput = {
  tenantId: 'ten_nova',
  customer: CUSTOMER,
  origin: ORIGIN_BANK,
  destination: DESTINATION_BANK,
  products: PRODUCTS,
  recurringPayments: RECURRING_PAYMENTS,
};
