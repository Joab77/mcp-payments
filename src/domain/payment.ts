import { DomainError } from './errors.js'
import { sameMoney, type Money } from './money.js'
import type { PhoneNumber } from './phone.js'

export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'expired'

// Une seule forme aujourd'hui. La carte ou le lien de paiement s'ajouteront ici.
export type Payer = { readonly kind: 'phone'; readonly phone: PhoneNumber }

// Des causes communes à tous les fournisseurs : l'assistant ne lit jamais un code propre à l'un d'eux.
export type FailureReason =
  | 'payer_rejected'
  | 'payer_not_found'
  | 'timed_out'
  | 'possibly_insufficient_funds'
  | 'not_allowed'
  | 'service_unavailable'
  | 'provider_refused'
  | 'unknown'

export interface PaymentFailure {
  readonly reason: FailureReason
  // Le code d'origine, gardé pour le diagnostic.
  readonly providerCode: string | null
}

export interface StatusChange {
  readonly status: PaymentStatus
  readonly at: Date
}

export interface Payment {
  readonly reference: string
  readonly providerId: string
  readonly providerRef: string
  readonly payer: Payer
  readonly amount: Money
  readonly reason: string
  readonly status: PaymentStatus
  readonly failure: PaymentFailure | null
  readonly history: readonly StatusChange[]
}

export type NewPayment = Omit<Payment, 'status' | 'failure' | 'history'>

// Identifie un payeur pour les plafonds et le stockage.
export function payerKey(payer: Payer): string {
  return payer.phone.e164
}

export function parseMerchantReference(raw: string): string {
  const reference = raw.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(reference)) {
    throw new DomainError('INVALID_REFERENCE', `Référence marchande invalide : ${raw}`)
  }
  return reference
}

export function createPayment(fields: NewPayment, at: Date): Payment {
  if (fields.amount.minorUnits === 0) {
    throw new DomainError('INVALID_AMOUNT', 'Un paiement ne peut pas être nul')
  }
  return { ...fields, status: 'pending', failure: null, history: [{ status: 'pending', at }] }
}

export function isSameDemand(
  payment: Payment,
  demand: { payer: Payer; amount: Money; reason: string },
): boolean {
  return (
    payerKey(payment.payer) === payerKey(demand.payer) &&
    sameMoney(payment.amount, demand.amount) &&
    payment.reason === demand.reason
  )
}

// Un paiement ne quitte « pending » qu'une fois : un statut final ne se réécrit jamais.
export function applyStatus(
  payment: Payment,
  status: PaymentStatus,
  at: Date,
  failure: PaymentFailure | null = null,
): Payment {
  if (status === payment.status) return payment
  if (payment.status !== 'pending') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `Passage de ${payment.status} à ${status} refusé pour ${payment.reference}`,
    )
  }
  return { ...payment, status, failure, history: [...payment.history, { status, at }] }
}
