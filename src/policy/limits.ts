import { DomainError } from '../domain/errors.js'
import type { Money } from '../domain/money.js'

export interface CurrencyLimits {
  readonly perPayment: number
  readonly perDay: number
  readonly perPayerPerDay: number
}

// Par devise, car le serveur ne convertit jamais.
export type PaymentLimits = Readonly<Record<string, CurrencyLimits>>

export interface RecentSpending {
  readonly merchantTotal: number
  readonly payerTotal: number
}

export function assertWithinLimits(
  amount: Money,
  spending: RecentSpending,
  limits: PaymentLimits,
): void {
  const applicable = limits[amount.currency]
  // Une devise sans plafond configuré est refusée : l'oubli ne doit pas ouvrir la porte.
  if (!applicable) {
    throw new DomainError('LIMIT_EXCEEDED', `Aucun plafond configuré pour ${amount.currency}`)
  }
  if (amount.minorUnits > applicable.perPayment) {
    throw new DomainError('LIMIT_EXCEEDED', 'Plafond par paiement dépassé')
  }
  if (spending.merchantTotal + amount.minorUnits > applicable.perDay) {
    throw new DomainError('LIMIT_EXCEEDED', 'Plafond journalier dépassé')
  }
  if (spending.payerTotal + amount.minorUnits > applicable.perPayerPerDay) {
    throw new DomainError('LIMIT_EXCEEDED', 'Plafond journalier de ce numéro dépassé')
  }
}
