import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PaymentService } from '../../src/app/PaymentService.js'
import { BJ } from '../../src/countries/BJ.js'
import { FakeProvider } from '../../src/providers/fake/FakeProvider.js'
import { ProviderRouter } from '../../src/routing/ProviderRouter.js'
import { SqlitePaymentRepository } from '../../src/store/sqlite/SqlitePaymentRepository.js'

describe('après un redémarrage', () => {
  it('garde le lien entre la référence et le fournisseur', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mcp-mobile-money-'))
    const path = join(folder, 'payments.db')
    const options = {
      country: BJ,
      environment: 'production' as const,
      router: new ProviderRouter([new FakeProvider('XOF')]),
      limits: { XOF: { perPayment: 50000, perDay: 100000, perPayerPerDay: 60000 } },
    }
    const demand = { reference: 'CMD-1', phone: '0197000045', minorUnits: 1500, reason: 'Commande' }

    const firstStore = new SqlitePaymentRepository(path)
    const first = await new PaymentService({ ...options, repository: firstStore }).requestPayment(demand)
    firstStore.close()

    const secondStore = new SqlitePaymentRepository(path)
    const again = await new PaymentService({ ...options, repository: secondStore }).requestPayment(demand)
    secondStore.close()
    rmSync(folder, { recursive: true })

    expect(again.providerRef).toBe(first.providerRef)
  })
})
