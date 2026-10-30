import type { OperatorId } from '../domain/country.js'
import type { Currency, Money } from '../domain/money.js'
import type { Payer, PaymentFailure, PaymentStatus } from '../domain/payment.js'
import type { PhoneNumber } from '../domain/phone.js'

export type ProviderOperation = 'requestPayment' | 'getBalance' | 'checkAccount'

export interface ProviderCapabilities {
  readonly countries: readonly string[]
  readonly operators: readonly OperatorId[]
  readonly currencies: readonly Currency[]
  readonly payerKinds: readonly Payer['kind'][]
  readonly operations: readonly ProviderOperation[]
}

export interface PaymentRequest {
  // Créé une seule fois par le service pour une référence marchande, puis gardé en base.
  readonly providerRef: string
  readonly reference: string
  readonly payer: Payer
  readonly amount: Money
  readonly reason: string
}

export interface ProviderPayment {
  readonly providerRef: string
  readonly status: PaymentStatus
  readonly payer: Payer
  readonly amount: Money
  // Facultatif : un fournisseur qui ne donne pas de cause laisse le champ vide.
  readonly failure?: PaymentFailure | null
}

export interface AccountCheck {
  readonly active: boolean
  readonly operator: OperatorId | null
}

// Une DomainError levée ici est un refus certain. Toute autre erreur laisse l'issue inconnue.
export interface PaymentProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  requestPayment(input: PaymentRequest): Promise<ProviderPayment>
  getPayment(providerRef: string): Promise<ProviderPayment>
  getBalance?(): Promise<Money>
  checkAccount?(phone: PhoneNumber): Promise<AccountCheck>
}
