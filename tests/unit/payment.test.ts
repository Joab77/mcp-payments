import { describe, expect, it } from 'vitest'
import { BJ } from '../../src/countries/BJ.js'
import { money } from '../../src/domain/money.js'
import { applyStatus, createPayment, parseMerchantReference } from '../../src/domain/payment.js'
import { parsePhoneNumber } from '../../src/domain/phone.js'

const start = new Date('2026-10-30T10:00:00Z')
const later = new Date('2026-10-30T10:05:00Z')

function pendingPayment() {
  return createPayment(
    {
      reference: 'CMD-2026-0412',
      providerId: 'fake',
      providerRef: 'ref-1',
      payer: { kind: 'phone', phone: parsePhoneNumber('0197000045', BJ) },
      amount: money(1500, 'XOF'),
      reason: 'Commande Dantokpa',
    },
    start,
  )
}

describe('payment', () => {
  it('commence en attente, avec son historique', () => {
    expect(pendingPayment().history).toEqual([{ status: 'pending', at: start }])
  })

  it('refuse un montant nul', () => {
    const { reference, providerId, providerRef, payer, reason } = pendingPayment()
    const fields = { reference, providerId, providerRef, payer, reason, amount: money(0, 'XOF') }
    expect(() => createPayment(fields, start)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AMOUNT' }),
    )
  })

  it('consigne le passage à un statut final', () => {
    const paid = applyStatus(pendingPayment(), 'successful', later)
    expect(paid.status).toBe('successful')
    expect(paid.history).toHaveLength(2)
  })

  it('garde la cause d’un échec', () => {
    const failure = { reason: 'payer_rejected' as const, providerCode: 'APPROVAL_REJECTED' }
    expect(applyStatus(pendingPayment(), 'failed', later, failure).failure).toEqual(failure)
    expect(pendingPayment().failure).toBeNull()
  })

  it('ne change rien quand le statut est le même', () => {
    const paid = applyStatus(pendingPayment(), 'successful', later)
    expect(applyStatus(paid, 'successful', later)).toBe(paid)
  })

  it('ne réécrit jamais un statut final', () => {
    const paid = applyStatus(pendingPayment(), 'successful', later)
    expect(() => applyStatus(paid, 'failed', later)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSITION' }),
    )
  })

  it('valide la référence marchande', () => {
    expect(parseMerchantReference(' CMD-2026-0412 ')).toBe('CMD-2026-0412')
    expect(() => parseMerchantReference('CMD 0412; DROP')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REFERENCE' }),
    )
  })
})
