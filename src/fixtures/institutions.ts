import type { Institution } from '../domain/types.js';

/**
 * Fictional institutions. Names are placeholders standing in for a large
 * incumbent and an online challenger; capabilities are invented for the
 * prototype and are not statements about any real institution.
 */

export const ORIGIN_BANK: Institution = {
  id: 'inst_origin_incumbent',
  name: 'Banque Meridienne',
  country: 'FR',
  type: 'BANK',
  bic: 'MERIFRPPXXX',
  capabilities: {
    supportedProducts: [
      'CURRENT_ACCOUNT',
      'LIVRET_A',
      'LDDS',
      'LEP',
      'PEL',
      'CEL',
      'PEA',
      'CTO',
      'ASSURANCE_VIE',
      'LOAN',
      'MORTGAGE',
      'CREDIT_CARD',
      'INSURANCE',
    ],
    supportsBankMobilityScheme: true,
    supportsSecuritiesTransferIn: true,
    hasApi: false,
  },
};

export const DESTINATION_BANK: Institution = {
  id: 'inst_dest_challenger',
  name: 'Nova Banque',
  country: 'FR',
  type: 'NEOBANK',
  bic: 'NOVAFRP2XXX',
  capabilities: {
    // Deliberately narrower than the incumbent: no LEP, no assurance-vie, no
    // mortgages. This is what makes the plan interesting — a real destination
    // never mirrors the origin's shelf, and the engine has to say so.
    supportedProducts: [
      'CURRENT_ACCOUNT',
      'LIVRET_A',
      'LDDS',
      'PEA',
      'CTO',
      'CREDIT_CARD',
    ],
    supportsBankMobilityScheme: true,
    supportsSecuritiesTransferIn: true,
    hasApi: true,
  },
};

/** A destination with no securities desk — used to exercise the blocked path. */
export const DESTINATION_NO_SECURITIES: Institution = {
  ...DESTINATION_BANK,
  id: 'inst_dest_deposit_only',
  name: 'Dépôt Direct',
  capabilities: {
    ...DESTINATION_BANK.capabilities,
    supportedProducts: ['CURRENT_ACCOUNT', 'LIVRET_A', 'LDDS', 'CREDIT_CARD'],
    supportsSecuritiesTransferIn: false,
  },
};
