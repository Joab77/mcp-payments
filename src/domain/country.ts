import type { Currency } from './money.js'

// Un texte libre : un nouveau pays apporte ses opérateurs sans toucher au domaine.
export type OperatorId = string

export interface CountryProfile {
  readonly code: string
  readonly dialCode: string
  // Le numéro tel qu'il suit l'indicatif en E.164.
  readonly nationalPattern: RegExp
  // Préfixe composé seulement à l'intérieur du pays, absent en E.164 (0 au Nigeria).
  // Le 01 du Bénin n'en est pas un : il fait partie du numéro.
  readonly trunkPrefix?: string
  // Ancien format encore rencontré dans les carnets d'adresses.
  readonly legacyNumber?: { readonly length: number; readonly prefix: string }
  readonly currency: Currency
  readonly operators: readonly OperatorId[]
}
