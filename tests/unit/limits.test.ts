import { describe, expect, it } from 'vitest'
import { money } from '../../src/domain/money.js'
import { assertWithinLimits } from '../../src/policy/limits.js'

const limits = { XOF: { perPayment: 50000, perDay: 100000, perPayerPerDay: 60000 } }
const fresh = { merchantTotal: 0, payerTotal: 0 }

describe('assertWithinLimits', () => {
  it('laisse passer un montant égal au plafond', () => {
    expect(() => assertWithinLimits(money(50000, 'XOF'), fresh, limits)).not.toThrow()
  })

  it.each([
    ['par paiement', 50001, fresh],
    ['par jour', 1000, { merchantTotal: 99500, payerTotal: 0 }],
    ['par numéro', 1000, { merchantTotal: 0, payerTotal: 59500 }],
  ])('refuse au-delà du plafond %s', (_label, amount, spending) => {
    expect(() => assertWithinLimits(money(amount, 'XOF'), spending, limits)).toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
    )
  })

  it('refuse une devise sans plafond configuré', () => {
    expect(() => assertWithinLimits(money(1, 'EUR'), fresh, limits)).toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
    )
  })
})
