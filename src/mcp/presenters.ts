import { z } from 'zod'
import type { CountryProfile } from '../domain/country.js'
import type { Money } from '../domain/money.js'
import type { FailureReason, Payment } from '../domain/payment.js'
import { maskPhoneNumber } from '../domain/phone.js'

// Intl connaît les décimales ISO 4217 de chaque devise : XOF 0, EUR 2, NGN 2.
export function formatMoney(amount: Money): string {
  const formatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: amount.currency })
  const decimals = formatter.resolvedOptions().maximumFractionDigits ?? 0
  return formatter.format(amount.minorUnits / 10 ** decimals)
}

// Ce que l'assistant peut dire au commerçant. Une référence ayant échoué ne se rejoue pas.
const FAILURE_ADVICE: Readonly<Record<FailureReason, string>> = {
  payer_rejected: 'Le client a refusé la demande sur son téléphone.',
  payer_not_found: "Ce numéro n'a pas de compte Mobile Money actif. Vérifier le numéro avec le client.",
  timed_out:
    "Le client n'a pas validé à temps. Le prévenir, puis refaire une demande avec une nouvelle référence.",
  possibly_insufficient_funds:
    "Le plus souvent, le solde du client est insuffisant, sans certitude. Lui demander de vérifier son solde, puis refaire une demande avec une nouvelle référence.",
  not_allowed: "Ce paiement n'est pas autorisé pour ce compte marchand. Voir avec le fournisseur.",
  service_unavailable:
    'Le service du fournisseur était indisponible. Refaire une demande plus tard, avec une nouvelle référence.',
  provider_refused: "Le fournisseur a refusé la demande avant de l'envoyer au client.",
  unknown: "Le fournisseur n'a pas donné de cause connue.",
}

export const moneyOutput = z.object({
  minorUnits: z.number().int(),
  currency: z.string(),
  label: z.string(),
})

export const paymentOutput = z.object({
  reference: z.string(),
  status: z.enum(['pending', 'successful', 'failed', 'expired']),
  amount: moneyOutput,
  phone: z.string().describe('Numéro masqué'),
  reason: z.string(),
  failure: z
    .object({
      reason: z.string().describe('Cause commune à tous les fournisseurs'),
      advice: z.string().describe('Ce qu’on peut dire ou faire ensuite'),
      providerCode: z.string().nullable(),
    })
    .nullable()
    .describe('Renseigné seulement pour un paiement failed ou expired'),
  providerId: z.string(),
  history: z.array(z.object({ status: z.string(), at: z.string() })),
})

export function presentMoney(amount: Money) {
  return { minorUnits: amount.minorUnits, currency: amount.currency, label: formatMoney(amount) }
}

// Le seul chemin par lequel un paiement sort vers le modèle : le numéro y est toujours masqué.
export function presentPayment(payment: Payment, country: CountryProfile) {
  return {
    reference: payment.reference,
    status: payment.status,
    amount: presentMoney(payment.amount),
    phone: maskPhoneNumber(payment.payer.phone, country),
    reason: payment.reason,
    failure: payment.failure && {
      reason: payment.failure.reason,
      advice: FAILURE_ADVICE[payment.failure.reason],
      providerCode: payment.failure.providerCode,
    },
    providerId: payment.providerId,
    history: payment.history.map((change) => ({
      status: change.status,
      at: change.at.toISOString(),
    })),
  }
}
