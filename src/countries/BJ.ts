import type { CountryProfile } from '../domain/country.js'

// Numéros à dix chiffres depuis le 30 novembre 2024 : préfixe 01 pour MTN, Moov et Celtiis.
// Source : https://cio-mag.com/benin-le-plan-de-numerotation-passe-a-10-chiffres-en-novembre-2024/
// Pas de plages par opérateur ici, faute de source officielle : check_account tranche.
export const BJ: CountryProfile = {
  code: 'BJ',
  dialCode: '229',
  nationalPattern: /^01\d{8}$/,
  legacyNumber: { length: 8, prefix: '01' },
  currency: 'XOF',
  operators: ['mtn', 'moov', 'celtiis'],
}
