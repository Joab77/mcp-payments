import { describe, expect, it } from 'vitest'
import { PaymentService, ProviderRouter, SqlitePaymentRepository } from '../../src/lib.js'
import type { CountryProfile, PaymentProvider, ProviderPayment } from '../../src/lib.js'

// Preuve de la promesse du README : un pays et un fournisseur ajoutés sans toucher au cœur.
const NG: CountryProfile = {
  code: 'NG',
  dialCode: '234',
  nationalPattern: /^[789]\d{9}$/,
  trunkPrefix: '0',
  currency: 'NGN',
  operators: ['airtel'],
}

const stored = new Map<string, ProviderPayment>()
const nigerianProvider: PaymentProvider = {
  id: 'exemple-ng',
  capabilities: {
    countries: ['NG'],
    operators: ['airtel'],
    currencies: ['NGN'],
    payerKinds: ['phone'],
    operations: ['requestPayment'],
  },
  async requestPayment(input) {
    const created = { ...input, status: 'pending' as const }
    stored.set(input.providerRef, created)
    return created
  },
  async getPayment(providerRef) {
    return stored.get(providerRef)!
  },
}

describe('extension', () => {
  it('encaisse dans un autre pays, une autre devise, chez un autre fournisseur', async () => {
    const service = new PaymentService({
      country: NG,
      environment: 'production',
      router: new ProviderRouter([nigerianProvider]),
      repository: new SqlitePaymentRepository(':memory:'),
      limits: { NGN: { perPayment: 5000000, perDay: 5000000, perPayerPerDay: 5000000 } },
    })
    const payment = await service.requestPayment({
      reference: 'NG-1',
      phone: '08031234567',
      minorUnits: 250000,
      reason: 'Commande',
    })
    expect(payment.amount.currency).toBe('NGN')
    expect(payment.payer.phone.e164).toBe('+2348031234567')
  })
})
