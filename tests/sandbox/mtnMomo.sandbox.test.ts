import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it } from 'vitest'
import { money, type Money } from '../../src/domain/money.js'
import { MtnMomoProvider } from '../../src/providers/mtn-momo/MtnMomoProvider.js'
import { runProviderContract } from '../contract/providerContract.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} manquante : lancer par npm run test:sandbox`)
  return value
}

// La sandbox limite son débit par des 429 : un 429 n'a rien traité, on peut donc le rejouer ici.
// En production, c'est au service de décider : ce détour reste propre aux tests.
const patientFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init)
    if (response.status !== 429 || attempt === 8) return response
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

// Un seul fournisseur, donc un seul jeton pour toute la suite.
let shared: MtnMomoProvider | null = null
const makeProvider = () => (shared ??= createProvider())

const createProvider = () =>
  new MtnMomoProvider({
    fetch: patientFetch,
    baseUrl: 'https://sandbox.momodeveloper.mtn.com',
    targetEnvironment: 'sandbox',
    subscriptionKey: required('MOMO_SUBSCRIPTION_KEY'),
    apiUser: required('MOMO_API_USER'),
    apiKey: required('MOMO_API_KEY'),
    country: 'BJ',
    currency: 'EUR',
  })

// Les numéros de la sandbox ne sont pas béninois : on les donne déjà normalisés.
const sandboxNumber = (e164: string) => ({ e164, countryCode: 'BJ' })

runProviderContract('mtn-momo, sandbox réelle', {
  makeProvider,
  currency: 'EUR',
  numbers: {
    successful: sandboxNumber('+2290197000045'),
    failed: sandboxNumber('+46733123451'),
    pending: sandboxNumber('+46733123453'),
  },
})

describe('mtn-momo, causes réelles', () => {
  it.each([
    ['+46733123450', 'possibly_insufficient_funds', 'INTERNAL_PROCESSING_ERROR'],
    ['+46733123451', 'payer_rejected', 'APPROVAL_REJECTED'],
    ['+46733123452', 'timed_out', 'EXPIRED'],
    ['+46733123455', 'payer_not_found', 'PAYER_NOT_FOUND'],
    ['+46733123463', 'timed_out', 'COULD_NOT_PERFORM_TRANSACTION'],
  ])('%s donne %s', async (e164, reason, providerCode) => {
    const provider = makeProvider()
    const providerRef = randomUUID()
    await provider.requestPayment({
      providerRef,
      reference: 'CMD-CAUSE',
      payer: { kind: 'phone', phone: sandboxNumber(e164) },
      amount: money(100, 'EUR'),
      reason: 'Essai',
    })
    expect((await provider.getPayment(providerRef)).failure).toEqual({ reason, providerCode })
  })
})

describe('mtn-momo, motifs réels', () => {
  it.each(["Commande d'Ayélé", 'Commande n°12 (urgent) !', 'Réglée à 100 % ? "oui" & €'])(
    'fait passer « %s » malgré le pare-feu',
    async (reason) => {
      const created = await makeProvider().requestPayment({
        providerRef: randomUUID(),
        reference: 'CMD-MOTIF',
        payer: { kind: 'phone', phone: sandboxNumber('+2290197000045') },
        amount: money(100, 'EUR'),
        reason,
      })
      expect(created.status).toBe('pending')
    },
  )
})

describe('mtn-momo, lectures réelles', () => {
  // La sandbox tire au sort sa réponse : 1000, 0, -25, ou une erreur simulée (mesuré sur 24 appels).
  it('lit le solde en euros', async () => {
    const provider = makeProvider()
    let balance: Money | null = null
    for (let attempt = 0; attempt < 20 && !balance; attempt++) {
      balance = await provider.getBalance().catch(() => null)
    }
    expect(balance?.currency).toBe('EUR')
  }, 120_000)

  it('distingue un compte actif d’un compte absent', async () => {
    const provider = makeProvider()
    expect((await provider.checkAccount(sandboxNumber('+46733123459'))).active).toBe(true)
    expect((await provider.checkAccount(sandboxNumber('+46733123450'))).active).toBe(false)
    expect((await provider.checkAccount(sandboxNumber('+46733123451'))).active).toBe(false)
  })
})

describe('le serveur compilé, de bout en bout, contre la sandbox', () => {
  it('confirme, encaisse et suit un paiement réel de sandbox', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mcp-mobile-money-sandbox-'))
    const client = new Client(
      { name: 'sandbox', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    let confirmations = 0
    client.setRequestHandler('elicitation/create', async () => {
      confirmations++
      return { action: 'accept', content: { confirm: true } }
    })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/index.js'],
        env: {
          PAY_ENV: 'sandbox',
          PAY_PROVIDERS: 'mtn-momo',
          PAY_DB_PATH: join(folder, 'sandbox.db'),
          MOMO_SUBSCRIPTION_KEY: required('MOMO_SUBSCRIPTION_KEY'),
          MOMO_API_USER: required('MOMO_API_USER'),
          MOMO_API_KEY: required('MOMO_API_KEY'),
        },
      }),
    )

    try {
      const args = { reference: 'SBX-1', phone: '0197000045', amount: 1250, reason: 'Essai sandbox' }
      const created = await client.callTool({ name: 'request_payment', arguments: args })
      expect(created.isError).toBeFalsy()
      expect(created.structuredContent).toMatchObject({
        amount: { minorUnits: 1250, currency: 'EUR' },
        phone: '+229 01 97 •• •• 45',
      })

      const status = await client.callTool({ name: 'get_payment_status', arguments: { reference: 'SBX-1' } })
      expect(status.structuredContent).toMatchObject({ status: 'successful' })

      await client.callTool({ name: 'request_payment', arguments: args })
      expect(confirmations).toBe(1)
    } finally {
      await client.close()
      rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)
})
