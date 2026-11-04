import { beforeEach, describe, expect, it } from 'vitest'
import { BJ } from '../../src/countries/BJ.js'
import { money } from '../../src/domain/money.js'
import { applyStatus, createPayment, type Payment } from '../../src/domain/payment.js'
import { parsePhoneNumber } from '../../src/domain/phone.js'
import type { PaymentRepository } from '../../src/store/PaymentRepository.js'

const start = new Date('2026-10-30T10:00:00Z')

function samplePayment(reference: string, rawPhone = '0197000045', minorUnits = 1500): Payment {
  return createPayment(
    {
      reference,
      providerId: 'fake',
      providerRef: `ref-${reference}`,
      payer: { kind: 'phone', phone: parsePhoneNumber(rawPhone, BJ) },
      amount: money(minorUnits, 'XOF'),
      reason: 'Commande Dantokpa',
    },
    start,
  )
}

// Une base qui passe ces scénarios remplace SQLite sans rien changer d'autre.
export function runRepositoryContract(name: string, makeRepository: () => PaymentRepository) {
  describe(`contrat PaymentRepository : ${name}`, () => {
    let repository: PaymentRepository

    beforeEach(() => {
      repository = makeRepository()
    })

    it('rend un paiement tel qu’il a été enregistré', async () => {
      const payment = samplePayment('CMD-1')
      await repository.insert(payment)
      expect(await repository.findByReference('CMD-1')).toEqual(payment)
    })

    it('rend null pour une référence inconnue', async () => {
      expect(await repository.findByReference('CMD-X')).toBeNull()
    })

    it('refuse une référence déjà employée', async () => {
      await repository.insert(samplePayment('CMD-1'))
      await expect(repository.insert(samplePayment('CMD-1'))).rejects.toMatchObject({
        code: 'PAYMENT_CONFLICT',
      })
    })

    it('enregistre le statut et son historique', async () => {
      const payment = samplePayment('CMD-1')
      await repository.insert(payment)
      const paid = applyStatus(payment, 'successful', new Date('2026-10-30T10:05:00Z'))
      await repository.save(paid)
      expect(await repository.findByReference('CMD-1')).toEqual(paid)
    })

    it('garde la cause d’un échec', async () => {
      const payment = samplePayment('CMD-1')
      await repository.insert(payment)
      const failure = { reason: 'payer_rejected' as const, providerCode: 'APPROVAL_REJECTED' }
      await repository.save(applyStatus(payment, 'failed', start, failure))
      expect((await repository.findByReference('CMD-1'))?.failure).toEqual(failure)
    })

    it('liste du plus récent au plus ancien, dans la limite demandée', async () => {
      await repository.insert(samplePayment('CMD-1'))
      await repository.insert(samplePayment('CMD-2'))
      await repository.insert(samplePayment('CMD-3'))
      const recent = await repository.listRecent(2)
      expect(recent.map((payment) => payment.reference)).toEqual(['CMD-3', 'CMD-2'])
    })

    it('ne compte dans les totaux ni les échecs, ni une autre devise, ni le passé', async () => {
      const since = new Date('2026-10-30T00:00:00Z')
      const failed = samplePayment('CMD-2', '0197000045', 700)
      await repository.insert(samplePayment('CMD-1', '0197000045', 1000))
      await repository.insert(failed)
      await repository.save(applyStatus(failed, 'failed', start))
      await repository.insert(samplePayment('CMD-3', '0197000046', 500))

      expect(await repository.totalRequestedSince({ since, currency: 'XOF' })).toBe(1500)
      expect(await repository.totalRequestedSince({ since, currency: 'EUR' })).toBe(0)
      expect(
        await repository.totalRequestedSince({ since, currency: 'XOF', payerKey: '+2290197000046' }),
      ).toBe(500)
      expect(
        await repository.totalRequestedSince({
          since: new Date('2026-10-31T00:00:00Z'),
          currency: 'XOF',
        }),
      ).toBe(0)
    })
  })
}
