import { DomainError } from '../../domain/errors.js'
import type { Currency, Money } from '../../domain/money.js'
import { signedMoney } from '../../domain/money.js'

function decimalsOf(currency: Currency): number {
  const formatter = new Intl.NumberFormat('en', { style: 'currency', currency })
  return formatter.resolvedOptions().maximumFractionDigits ?? 0
}

// Tout passe par le texte : pas de nombre à virgule entre l'API et un montant entier.
export function toMomoAmount(amount: Money): string {
  const decimals = decimalsOf(amount.currency)
  if (decimals === 0) return String(amount.minorUnits)
  const digits = String(amount.minorUnits).padStart(decimals + 1, '0')
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
}

// MTN écrit « 5 », « 12.5 » ou « -25 ».
export function fromMomoAmount(raw: string, currency: Currency): Money {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw)
  const decimals = decimalsOf(currency)
  const fraction = match?.[3] ?? ''
  if (!match || fraction.length > decimals) {
    throw new DomainError('INVALID_AMOUNT', `Montant MTN illisible : ${raw}`)
  }
  const minorUnits = Number(`${match[2]}${fraction.padEnd(decimals, '0')}`)
  return signedMoney(match[1] === '-' ? -minorUnits : minorUnits, currency)
}
