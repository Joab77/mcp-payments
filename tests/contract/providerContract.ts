import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { money, type Currency } from '../../src/domain/money.js'
import type { PaymentStatus } from '../../src/domain/payment.js'
import type { PhoneNumber } from '../../src/domain/phone.js'
import type { PaymentProvider, PaymentRequest } from '../../src/providers/PaymentProvider.js'

export interface ContractFixture {
  makeProvider(): PaymentProvider
  currency: Currency
  // Un numéro par issue, propre à l'environnement du fournisseur.
  numbers: { successful: PhoneNumber; failed: PhoneNumber; pending: PhoneNumber }
}

// Les mêmes scénarios pour chaque fournisseur : celui qui les passe est branché.
export function runProviderContract(name: string, fixture: ContractFixture) {
  describe(`contrat PaymentProvider : ${name}`, () => {
    let provider: PaymentProvider

    beforeEach(() => {
      provider = fixture.makeProvider()
    })

    function requestFor(phone: PhoneNumber): PaymentRequest {
      return {
        providerRef: randomUUID(),
        reference: 'CMD-2026-0412',
        payer: { kind: 'phone', phone },
        amount: money(1500, fixture.currency),
        reason: 'Commande Dantokpa',
      }
    }

    async function settledStatus(providerRef: string): Promise<PaymentStatus> {
      let status: PaymentStatus = 'pending'
      for (let attempt = 0; attempt < 10 && status === 'pending'; attempt++) {
        status = (await provider.getPayment(providerRef)).status
      }
      return status
    }

    it('déclare sa devise et le pays du contrat', () => {
      expect(provider.capabilities.currencies).toContain(fixture.currency)
      expect(provider.capabilities.countries).toContain('BJ')
    })

    it('accepte une demande sans la tenir pour réussie', async () => {
      const created = await provider.requestPayment(requestFor(fixture.numbers.successful))
      expect(created.status).toBe('pending')
    })

    it('rend la même demande quand la référence revient', async () => {
      const request = requestFor(fixture.numbers.successful)
      const first = await provider.requestPayment(request)
      const replay = await provider.requestPayment(request)
      expect(replay.providerRef).toBe(first.providerRef)
    })

    it('refuse une référence reprise avec un autre montant', async () => {
      const request = requestFor(fixture.numbers.successful)
      await provider.requestPayment(request)
      const changed = { ...request, amount: money(9000, fixture.currency) }
      await expect(provider.requestPayment(changed)).rejects.toMatchObject({
        code: 'PAYMENT_CONFLICT',
      })
    })

    it('fait aboutir un paiement accepté', async () => {
      const { providerRef } = await provider.requestPayment(requestFor(fixture.numbers.successful))
      expect(await settledStatus(providerRef)).toBe('successful')
    })

    it('fait échouer un paiement refusé', async () => {
      const { providerRef } = await provider.requestPayment(requestFor(fixture.numbers.failed))
      expect(await settledStatus(providerRef)).toBe('failed')
    })

    it('garde en attente un paiement sans réponse du client', async () => {
      const { providerRef } = await provider.requestPayment(requestFor(fixture.numbers.pending))
      expect(await settledStatus(providerRef)).toBe('pending')
    })

    it('signale un paiement inconnu', async () => {
      await expect(provider.getPayment(randomUUID())).rejects.toMatchObject({
        code: 'PAYMENT_NOT_FOUND',
      })
    })

    it('refuse une devise non déclarée', async () => {
      const other: Currency = fixture.currency === 'XOF' ? 'EUR' : 'XOF'
      const request = { ...requestFor(fixture.numbers.successful), amount: money(1500, other) }
      await expect(provider.requestPayment(request)).rejects.toMatchObject({
        code: 'UNSUPPORTED_CURRENCY',
      })
    })
  })
}
