import { describe, expect, it } from 'vitest'
import { money, sameMoney } from '../../src/domain/money.js'

describe('money', () => {
  it('garde un montant entier dans sa devise', () => {
    expect(money(1500, 'XOF')).toEqual({ minorUnits: 1500, currency: 'XOF' })
  })

  it.each([12.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('refuse %s', (amount) => {
    expect(() => money(amount, 'XOF')).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }))
  })

  it('accepte une devise que le domaine ne connaît pas', () => {
    expect(money(100, 'NGN').currency).toBe('NGN')
  })

  it.each(['usd', 'toString', ''])('refuse le code « %s »', (currency) => {
    expect(() => money(100, currency)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURRENCY' }),
    )
  })

  it('distingue deux devises pour un même nombre', () => {
    expect(sameMoney(money(100, 'XOF'), money(100, 'EUR'))).toBe(false)
  })
})
