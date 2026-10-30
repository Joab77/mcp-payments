import type { CountryProfile } from './country.js'
import { DomainError } from './errors.js'

export interface PhoneNumber {
  readonly e164: string
  readonly countryCode: string
}

function toNationalNumber(digits: string, country: CountryProfile): string | null {
  if (country.nationalPattern.test(digits)) return digits

  const trunk = country.trunkPrefix
  if (trunk && digits.startsWith(trunk)) {
    const withoutTrunk = digits.slice(trunk.length)
    if (country.nationalPattern.test(withoutTrunk)) return withoutTrunk
  }

  const legacy = country.legacyNumber
  if (legacy && digits.length === legacy.length) {
    const migrated = legacy.prefix + digits
    if (country.nationalPattern.test(migrated)) return migrated
  }
  return null
}

export function parsePhoneNumber(raw: string, country: CountryProfile): PhoneNumber {
  const invalid = new DomainError('INVALID_PHONE', `Numéro invalide pour ${country.code}`)
  const compact = raw.trim().replace(/[\s.()-]/g, '')
  const isInternational = compact.startsWith('+') || compact.startsWith('00')
  const digits = compact.replace(/^(\+|00)/, '')

  if (!/^\d+$/.test(digits)) throw invalid

  const hasDialCode = digits.startsWith(country.dialCode)
  if (isInternational && !hasDialCode) throw invalid

  const afterDialCode = hasDialCode ? digits.slice(country.dialCode.length) : null
  // Sans « + », « 2290197000045 » et « 0197000045 » restent tous deux possibles.
  const national =
    (isInternational ? null : toNationalNumber(digits, country)) ??
    (afterDialCode === null ? null : toNationalNumber(afterDialCode, country))

  if (national === null) throw invalid
  return { e164: `+${country.dialCode}${national}`, countryCode: country.code }
}

// +2290197000045 devient « +229 01 97 •• •• 45 » : assez pour reconnaître, pas pour appeler.
export function maskPhoneNumber(phone: PhoneNumber, country: CountryProfile): string {
  const national = phone.e164.slice(country.dialCode.length + 1)
  const groups = national.match(/.{1,2}/g) ?? []
  const masked = groups.map((group, index) => {
    const isVisible = index < 2 || index === groups.length - 1
    return isVisible ? group : '••'
  })
  return `+${country.dialCode} ${masked.join(' ')}`
}
