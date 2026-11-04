import { z } from 'zod'
import { DomainError } from '../../domain/errors.js'
import { sameMoney, type Currency, type Money } from '../../domain/money.js'
import type { FailureReason, PaymentFailure, PaymentStatus } from '../../domain/payment.js'
import type { PhoneNumber } from '../../domain/phone.js'
import type {
  AccountCheck,
  PaymentProvider,
  PaymentRequest,
  ProviderCapabilities,
  ProviderPayment,
} from '../PaymentProvider.js'
import { fromMomoAmount, toMomoAmount } from './amounts.js'
import { MtnMomoClient, type MomoResponse, type MtnMomoClientOptions } from './MtnMomoClient.js'

const paymentBody = z.object({
  amount: z.string(),
  currency: z.string(),
  payer: z.object({ partyIdType: z.string(), partyId: z.string() }),
  status: z.enum(['CREATED', 'PENDING', 'SUCCESSFUL', 'FAILED']),
  reason: z.string().optional(),
})

// Refus certains que MTN répond en 500 (Common Error Codes de la doc, et mesuré pour certains).
const CERTAIN_REFUSAL_CODES = new Set([
  'NOT_ALLOWED',
  'NOT_ALLOWED_TARGET_ENVIRONMENT',
  'INVALID_CALLBACK_URL_HOST',
])

const errorBody = z.object({ code: z.string() })
const balanceBody = z.object({ availableBalance: z.string(), currency: z.string() })
const accountBody = z.object({ result: z.boolean() })

// Page Common Error Codes de MTN, et raisons mesurées sur les numéros de test.
const FAILURE_REASONS: Readonly<Record<string, FailureReason>> = {
  APPROVAL_REJECTED: 'payer_rejected',
  PAYER_NOT_FOUND: 'payer_not_found',
  EXPIRED: 'timed_out',
  COULD_NOT_PERFORM_TRANSACTION: 'timed_out',
  // MTN : « predominantly occurs due to insufficient customer funds », sans certitude.
  INTERNAL_PROCESSING_ERROR: 'possibly_insufficient_funds',
  NOT_ALLOWED: 'not_allowed',
  NOT_ALLOWED_TARGET_ENVIRONMENT: 'not_allowed',
  PAYEE_NOT_ALLOWED_TO_RECEIVE: 'not_allowed',
  SERVICE_UNAVAILABLE: 'service_unavailable',
}

export interface MtnMomoOptions extends MtnMomoClientOptions {
  readonly country: string
  readonly currency: Currency
}

// CREATED existe avant PENDING. Une expiration arrive en FAILED, avec la raison EXPIRED.
function toStatus(body: z.infer<typeof paymentBody>): PaymentStatus {
  if (body.status === 'SUCCESSFUL') return 'successful'
  if (body.status === 'FAILED') return body.reason === 'EXPIRED' ? 'expired' : 'failed'
  return 'pending'
}

function toFailure(body: z.infer<typeof paymentBody>): PaymentFailure | null {
  if (body.status !== 'FAILED') return null
  const code = body.reason ?? null
  return { reason: (code && FAILURE_REASONS[code]) || 'unknown', providerCode: code }
}

function errorCode(response: MomoResponse): string | undefined {
  return errorBody.safeParse(response.body).data?.code
}

// Mesuré en sandbox : tout autre caractère (' " ! ? ( ) # % & € ...) est bloqué avant l'API.
// Le motif complet reste en base, seul le message envoyé à MTN est nettoyé.
export function toMomoMessage(reason: string): string {
  const cleaned = reason
    .replace(/[^\p{L}\p{N} .,:\-_/+=@]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Paiement'
}

export class MtnMomoProvider implements PaymentProvider {
  readonly id = 'mtn-momo'
  readonly capabilities: ProviderCapabilities
  private readonly client: MtnMomoClient

  constructor(private readonly options: MtnMomoOptions) {
    this.client = new MtnMomoClient(options)
    this.capabilities = {
      countries: [options.country],
      operators: ['mtn'],
      currencies: [options.currency],
      payerKinds: ['phone'],
      operations: ['requestPayment', 'getBalance', 'checkAccount'],
    }
  }

  async requestPayment(input: PaymentRequest): Promise<ProviderPayment> {
    if (input.amount.currency !== this.options.currency) {
      throw new DomainError('UNSUPPORTED_CURRENCY', `Devise refusée : ${input.amount.currency}`)
    }

    const response = await this.client.create('/collection/v1_0/requesttopay', input.providerRef, {
      amount: toMomoAmount(input.amount),
      currency: input.amount.currency,
      externalId: input.reference,
      payer: { partyIdType: 'MSISDN', partyId: this.toPartyId(input.payer.phone) },
      payerMessage: toMomoMessage(input.reason),
      payeeNote: toMomoMessage(input.reason),
    })

    if (response.status === 202) {
      return {
        providerRef: input.providerRef,
        status: 'pending',
        payer: input.payer,
        amount: input.amount,
      }
    }
    if (response.status === 409) return this.existingPayment(input)

    const code = errorCode(response)
    if (code === 'INVALID_CURRENCY') {
      throw new DomainError('UNSUPPORTED_CURRENCY', `MTN refuse ${input.amount.currency}`)
    }
    // Le pare-feu de MTN bloque en répondant 200 et une page HTML : sans 202, rien n'est parti.
    // Seuls un 429 et un 5xx ordinaire laissent l'issue inconnue : le service vérifiera.
    const isCertainRefusal =
      (response.status < 500 && response.status !== 429) ||
      (code !== undefined && CERTAIN_REFUSAL_CODES.has(code))
    if (isCertainRefusal) {
      throw new DomainError('PROVIDER_REJECTED', `MTN a refusé la demande (${response.status}, ${code ?? 'sans code'})`)
    }
    throw new Error(`MTN requesttopay a répondu ${response.status}`)
  }

  async getPayment(providerRef: string): Promise<ProviderPayment> {
    const response = await this.client.read(`/collection/v1_0/requesttopay/${providerRef}`)
    if (response.status === 404) {
      throw new DomainError('PAYMENT_NOT_FOUND', `Paiement inconnu chez MTN : ${providerRef}`)
    }
    if (response.status !== 200) {
      throw new Error(`MTN requesttopay a répondu ${response.status} à la consultation`)
    }
    const body = paymentBody.parse(response.body)
    return {
      providerRef,
      status: toStatus(body),
      failure: toFailure(body),
      payer: {
        kind: 'phone',
        phone: { e164: `+${body.payer.partyId}`, countryCode: this.options.country },
      },
      amount: fromMomoAmount(body.amount, body.currency),
    }
  }

  async getBalance(): Promise<Money> {
    const response = await this.client.read('/collection/v1_0/account/balance')
    if (response.status !== 200) throw new Error(`MTN balance a répondu ${response.status}`)
    const body = balanceBody.parse(response.body)
    return fromMomoAmount(body.availableBalance, body.currency)
  }

  async checkAccount(phone: PhoneNumber): Promise<AccountCheck> {
    const partyId = this.toPartyId(phone)
    const response = await this.client.read(`/collection/v1_0/accountholder/msisdn/${partyId}/active`)
    // Mesuré en sandbox : un numéro sans compte actif répond 404.
    if (response.status === 404) return { active: false, operator: null }
    if (response.status !== 200) throw new Error(`MTN active a répondu ${response.status}`)
    const { result } = accountBody.parse(response.body)
    return result ? { active: true, operator: 'mtn' } : { active: false, operator: null }
  }

  // Un 409 veut dire que cet identifiant existe : la demande perdue était arrivée, ou c'en est une autre.
  private async existingPayment(input: PaymentRequest): Promise<ProviderPayment> {
    const existing = await this.getPayment(input.providerRef)
    const isSame =
      existing.payer.phone.e164 === input.payer.phone.e164 &&
      sameMoney(existing.amount, input.amount)
    if (!isSame) {
      throw new DomainError('PAYMENT_CONFLICT', `${input.providerRef} déjà employé autrement`)
    }
    return existing
  }

  // MTN attend le numéro sans le « + ».
  private toPartyId(phone: PhoneNumber): string {
    return phone.e164.slice(1)
  }
}
