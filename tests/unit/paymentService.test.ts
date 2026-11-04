import { beforeEach, describe, expect, it } from 'vitest'
import { PaymentService } from '../../src/app/PaymentService.js'
import { BJ } from '../../src/countries/BJ.js'
import { DomainError } from '../../src/domain/errors.js'
import { FakeProvider } from '../../src/providers/fake/FakeProvider.js'
import type { PaymentRequest, ProviderPayment } from '../../src/providers/PaymentProvider.js'
import { ProviderRouter } from '../../src/routing/ProviderRouter.js'
import { SqlitePaymentRepository } from '../../src/store/sqlite/SqlitePaymentRepository.js'

// Simule les coupures réseau et compte ce qui part réellement chez le fournisseur.
class FlakyProvider extends FakeProvider {
  sent: string[] = []
  cut: 'none' | 'before-arrival' | 'after-arrival' = 'none'
  lookupDown = false

  override async requestPayment(input: PaymentRequest): Promise<ProviderPayment> {
    if (this.cut === 'before-arrival') throw new Error('réseau coupé')
    this.sent.push(input.providerRef)
    const created = await super.requestPayment(input)
    if (this.cut === 'after-arrival') throw new Error('réponse perdue')
    return created
  }

  override async getPayment(providerRef: string): Promise<ProviderPayment> {
    if (this.lookupDown) throw new Error('réseau coupé')
    return super.getPayment(providerRef)
  }
}

const limits = {
  XOF: { perPayment: 50000, perDay: 100000, perPayerPerDay: 60000 },
  EUR: { perPayment: 5000, perDay: 10000, perPayerPerDay: 6000 },
}
const demand = {
  reference: 'CMD-2026-0412',
  phone: '0197000045',
  minorUnits: 1500,
  reason: 'Commande Dantokpa',
}

function makeService(provider: FakeProvider, environment: 'sandbox' | 'production' = 'production') {
  return new PaymentService({
    country: BJ,
    environment,
    router: new ProviderRouter([provider]),
    repository: new SqlitePaymentRepository(':memory:'),
    limits,
  })
}

describe('PaymentService', () => {
  let provider: FlakyProvider
  let service: PaymentService

  beforeEach(() => {
    provider = new FlakyProvider('XOF')
    service = makeService(provider)
  })

  describe('idempotence', () => {
    it('crée le paiement en attente, dans la devise du pays', async () => {
      const payment = await service.requestPayment(demand)
      expect(payment.status).toBe('pending')
      expect(payment.amount).toEqual({ minorUnits: 1500, currency: 'XOF' })
      expect(provider.sent).toHaveLength(1)
    })

    it('ne renvoie rien au fournisseur quand la référence revient', async () => {
      const first = await service.requestPayment(demand)
      const replay = await service.requestPayment(demand)
      expect(replay.providerRef).toBe(first.providerRef)
      expect(provider.sent).toHaveLength(1)
    })

    it.each([
      ['un autre montant', { minorUnits: 9000 }],
      ['un autre numéro', { phone: '0197000046' }],
      ['un autre motif', { reason: 'Autre chose' }],
    ])('refuse la même référence avec %s', async (_label, change) => {
      await service.requestPayment(demand)
      await expect(service.requestPayment({ ...demand, ...change })).rejects.toMatchObject({
        code: 'PAYMENT_CONFLICT',
      })
      expect(provider.sent).toHaveLength(1)
    })

    it('ne crée qu’un paiement pour deux appels simultanés', async () => {
      const [a, b] = await Promise.all([
        service.requestPayment(demand),
        service.requestPayment(demand),
      ])
      expect(a.providerRef).toBe(b.providerRef)
      expect(new Set(provider.sent).size).toBe(1)
    })

    it('reconnaît un numéro écrit autrement', async () => {
      await service.requestPayment(demand)
      await service.requestPayment({ ...demand, phone: '+229 01 97 00 00 45' })
      expect(provider.sent).toHaveLength(1)
    })
  })

  describe('coupures réseau', () => {
    it('retrouve le paiement quand la réponse se perd après son arrivée', async () => {
      provider.cut = 'after-arrival'
      const payment = await service.requestPayment(demand)
      expect(payment.status).toBe('successful')
      expect(provider.sent).toHaveLength(1)
    })

    it('reste en attente si la consultation échoue aussi, sans renvoyer', async () => {
      provider.cut = 'after-arrival'
      provider.lookupDown = true
      const payment = await service.requestPayment(demand)
      expect(payment.status).toBe('pending')
      expect(provider.sent).toHaveLength(1)
    })

    it('renvoie avec le même identifiant si la demande n’était jamais arrivée', async () => {
      provider.cut = 'before-arrival'
      const lost = await service.requestPayment(demand)
      expect(lost.status).toBe('pending')
      expect(provider.sent).toHaveLength(0)

      provider.cut = 'none'
      const replay = await service.requestPayment(demand)
      expect(provider.sent).toEqual([lost.providerRef])
      expect(replay.providerRef).toBe(lost.providerRef)
    })

    it('ne renvoie pas si le fournisseur est injoignable au moment de rejouer', async () => {
      provider.cut = 'before-arrival'
      await service.requestPayment(demand)
      provider.cut = 'none'
      provider.lookupDown = true
      await service.requestPayment(demand)
      expect(provider.sent).toHaveLength(0)
    })
  })

  describe('plafonds', () => {
    it('refuse sans rien envoyer ni enregistrer', async () => {
      await expect(service.requestPayment({ ...demand, minorUnits: 50001 })).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
      })
      expect(provider.sent).toHaveLength(0)
      expect(await service.listRecent()).toEqual([])
    })

    it('cumule par numéro sur la journée', async () => {
      await service.requestPayment({ ...demand, reference: 'A', minorUnits: 40000 })
      await expect(
        service.requestPayment({ ...demand, reference: 'B', minorUnits: 30000 }),
      ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    })

    it('tient le plafond face à des appels simultanés', async () => {
      const results = await Promise.allSettled([
        service.requestPayment({ ...demand, reference: 'A', minorUnits: 40000 }),
        service.requestPayment({ ...demand, reference: 'B', minorUnits: 40000 }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    })

    it('ne compte pas un paiement échoué', async () => {
      const refused = { ...demand, phone: '0197000040', minorUnits: 40000 }
      await service.requestPayment({ ...refused, reference: 'A' })
      await service.getPaymentStatus('A')
      await expect(
        service.requestPayment({ ...refused, reference: 'B' }),
      ).resolves.toMatchObject({ status: 'pending' })
    })

    it('laisse rejouer un paiement déjà compté', async () => {
      await service.requestPayment({ ...demand, minorUnits: 50000 })
      await expect(service.requestPayment({ ...demand, minorUnits: 50000 })).resolves.toBeDefined()
    })
  })

  describe('devises', () => {
    it('refuse une devise qu’aucun fournisseur ne déclare', async () => {
      await expect(service.requestPayment({ ...demand, currency: 'EUR' })).rejects.toMatchObject({
        code: 'NO_PROVIDER',
      })
    })

    it('prend la devise du fournisseur en sandbox', async () => {
      const sandbox = makeService(new FakeProvider('EUR'), 'sandbox')
      const payment = await sandbox.requestPayment(demand)
      expect(payment.amount.currency).toBe('EUR')
    })

    it('ne change jamais de devise en production', async () => {
      const strict = makeService(new FakeProvider('EUR'), 'production')
      await expect(strict.requestPayment(demand)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    })
  })

  describe('suivi', () => {
    it('met à jour le statut auprès du fournisseur et le garde', async () => {
      await service.requestPayment(demand)
      const payment = await service.getPaymentStatus(demand.reference)
      expect(payment.status).toBe('successful')
      expect((await service.getPayment(demand.reference)).status).toBe('successful')
    })

    it('garde la cause donnée par le fournisseur', async () => {
      await service.requestPayment({ ...demand, phone: '0197000041' })
      const payment = await service.getPaymentStatus(demand.reference)
      expect(payment.status).toBe('failed')
      expect(payment.failure?.reason).toBe('payer_rejected')
    })

    it('note un refus du fournisseur, en plus de le signaler', async () => {
      class RefusingProvider extends FakeProvider {
        override async requestPayment(): Promise<ProviderPayment> {
          throw new DomainError('PROVIDER_REJECTED', 'refusé')
        }
      }
      const refusing = makeService(new RefusingProvider('XOF'))
      await expect(refusing.requestPayment(demand)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' })
      const stored = await refusing.getPayment(demand.reference)
      expect(stored.failure).toEqual({ reason: 'provider_refused', providerCode: 'PROVIDER_REJECTED' })
    })

    it('rend le statut connu si le fournisseur est injoignable', async () => {
      await service.requestPayment(demand)
      provider.lookupDown = true
      const payment = await service.getPaymentStatus(demand.reference)
      expect(payment.status).toBe('pending')
    })

    it('signale une référence inconnue', async () => {
      await expect(service.getPaymentStatus('INCONNUE')).rejects.toMatchObject({
        code: 'PAYMENT_NOT_FOUND',
      })
    })

    it('ne consulte plus le fournisseur après un statut final', async () => {
      await service.requestPayment(demand)
      await service.getPaymentStatus(demand.reference)
      provider.lookupDown = true
      const payment = await service.getPaymentStatus(demand.reference)
      expect(payment.status).toBe('successful')
    })
  })

  it('donne le solde et vérifie un compte', async () => {
    await service.requestPayment(demand)
    await service.getPaymentStatus(demand.reference)
    expect(await service.getBalances()).toEqual([
      { providerId: 'fake', balance: { minorUnits: 1500, currency: 'XOF' } },
    ])
    expect(await service.checkAccount('0197000049')).toEqual({ active: false, operator: null })
  })
})
