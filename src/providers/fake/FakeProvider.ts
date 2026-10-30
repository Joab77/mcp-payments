import { DomainError } from '../../domain/errors.js'
import { money, sameMoney, type Currency, type Money } from '../../domain/money.js'
import { payerKey, type Payer, type PaymentFailure, type PaymentStatus } from '../../domain/payment.js'
import type { PhoneNumber } from '../../domain/phone.js'
import type {
  AccountCheck,
  PaymentProvider,
  PaymentRequest,
  ProviderCapabilities,
  ProviderPayment,
} from '../PaymentProvider.js'

// Le dernier chiffre du numéro décide de l'issue du paiement.
const OUTCOME_BY_LAST_DIGIT: Readonly<Record<string, PaymentStatus>> = {
  '0': 'failed',
  '1': 'failed',
  '2': 'expired',
  '3': 'pending',
  '4': 'pending',
}

const FAILURE_BY_LAST_DIGIT: Readonly<Record<string, PaymentFailure>> = {
  '0': { reason: 'possibly_insufficient_funds', providerCode: 'FAKE_INTERNAL_ERROR' },
  '1': { reason: 'payer_rejected', providerCode: 'FAKE_REJECTED' },
  '2': { reason: 'timed_out', providerCode: 'FAKE_EXPIRED' },
}

function outcomeFor(payer: Payer): PaymentStatus {
  return OUTCOME_BY_LAST_DIGIT[payer.phone.e164.slice(-1)] ?? 'successful'
}

export class FakeProvider implements PaymentProvider {
  readonly id = 'fake'
  readonly capabilities: ProviderCapabilities
  private readonly payments = new Map<string, ProviderPayment>()

  constructor(private readonly currency: Currency = 'XOF') {
    this.capabilities = {
      countries: ['BJ'],
      operators: ['mtn', 'moov', 'celtiis'],
      currencies: [currency],
      payerKinds: ['phone'],
      operations: ['requestPayment', 'getBalance', 'checkAccount'],
    }
  }

  async requestPayment(input: PaymentRequest): Promise<ProviderPayment> {
    if (input.amount.currency !== this.currency) {
      throw new DomainError('UNSUPPORTED_CURRENCY', `Devise refusée : ${input.amount.currency}`)
    }

    const existing = this.payments.get(input.providerRef)
    if (existing) {
      const isSamePayment =
        payerKey(existing.payer) === payerKey(input.payer) && sameMoney(existing.amount, input.amount)
      if (!isSamePayment) {
        throw new DomainError('PAYMENT_CONFLICT', `${input.providerRef} déjà employé autrement`)
      }
      return existing
    }

    // Comme chez un opérateur, la demande est d'abord en attente : l'issue vient à la consultation.
    const created: ProviderPayment = {
      providerRef: input.providerRef,
      status: 'pending',
      payer: input.payer,
      amount: input.amount,
    }
    this.payments.set(input.providerRef, created)
    return created
  }

  async getPayment(providerRef: string): Promise<ProviderPayment> {
    const stored = this.payments.get(providerRef)
    if (!stored) throw new DomainError('PAYMENT_NOT_FOUND', `Paiement inconnu : ${providerRef}`)

    const settled = {
      ...stored,
      status: outcomeFor(stored.payer),
      failure: FAILURE_BY_LAST_DIGIT[stored.payer.phone.e164.slice(-1)] ?? null,
    }
    this.payments.set(providerRef, settled)
    return settled
  }

  async getBalance(): Promise<Money> {
    let total = 0
    for (const payment of this.payments.values()) {
      if (payment.status === 'successful') total += payment.amount.minorUnits
    }
    return money(total, this.currency)
  }

  // Un numéro finissant par 9 sert à simuler un compte inactif.
  async checkAccount(phone: PhoneNumber): Promise<AccountCheck> {
    return phone.e164.endsWith('9')
      ? { active: false, operator: null }
      : { active: true, operator: 'mtn' }
  }
}
