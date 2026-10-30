import { DomainError } from './errors.js'

// Code ISO 4217. Le domaine n'en tient pas la liste : un pays ou un fournisseur les déclare.
export type Currency = string

export interface Money {
  // Toujours un entier, dans la plus petite unité de la devise : 1250 EUR = 12,50 €.
  readonly minorUnits: number
  readonly currency: Currency
}

export function money(minorUnits: number, currency: string): Money {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError('INVALID_CURRENCY', `Code de devise invalide : ${currency}`)
  }
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new DomainError('INVALID_AMOUNT', `Montant invalide : ${minorUnits}`)
  }
  return { minorUnits, currency }
}

// Un solde peut passer sous zéro (la sandbox MTN en rend) ; un montant à payer, jamais.
export function signedMoney(minorUnits: number, currency: string): Money {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new DomainError('INVALID_AMOUNT', `Montant invalide : ${minorUnits}`)
  }
  return { ...money(Math.abs(minorUnits), currency), minorUnits }
}

export function sameMoney(a: Money, b: Money): boolean {
  return a.minorUnits === b.minorUnits && a.currency === b.currency
}
