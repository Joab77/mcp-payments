import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import pino from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { PaymentService } from '../../src/app/PaymentService.js'
import { BJ } from '../../src/countries/BJ.js'
import { ConfirmationLedger } from '../../src/mcp/confirmation.js'
import { createServer } from '../../src/mcp/createServer.js'
import { FakeProvider } from '../../src/providers/fake/FakeProvider.js'
import type { PaymentRequest, ProviderPayment } from '../../src/providers/PaymentProvider.js'
import { ProviderRouter } from '../../src/routing/ProviderRouter.js'
import { SqlitePaymentRepository } from '../../src/store/sqlite/SqlitePaymentRepository.js'

class CountingProvider extends FakeProvider {
  sent = 0
  override async requestPayment(input: PaymentRequest): Promise<ProviderPayment> {
    this.sent++
    return super.requestPayment(input)
  }
}

const args = { reference: 'CMD-1', phone: '0197000045', amount: 1500, reason: 'Commande Dantokpa' }
const logger = pino({ level: 'silent' })

function buildServer(provider: FakeProvider, environment: 'sandbox' | 'production') {
  const service = new PaymentService({
    country: BJ,
    environment,
    router: new ProviderRouter([provider]),
    repository: new SqlitePaymentRepository(':memory:'),
    limits: { XOF: { perPayment: 50000, perDay: 200000, perPayerPerDay: 100000 } },
  })
  return createServer({
    service,
    country: BJ,
    environment,
    stateSecret: 'x'.repeat(32),
    logger,
    ledger: new ConfirmationLedger(),
  })
}

type Answer = { action: 'accept' | 'decline'; content?: { confirm: boolean } }

type Era = '2026-07-28' | 'legacy'

async function connect(
  era: Era,
  provider: FakeProvider,
  environment: 'sandbox' | 'production',
  answer?: (message: string) => Answer,
) {
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    {
      capabilities: answer ? { elicitation: { form: {} } } : {},
      versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: era } },
    },
  )
  if (answer) {
    client.setRequestHandler('elicitation/create', async (request) =>
      answer((request.params as { message: string }).message),
    )
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  // serveStdio choisit l'ère du protocole à l'ouverture, comme le vrai serveur.
  serveStdio(() => buildServer(provider, environment), { transport: serverSide })
  await client.connect(clientSide)
  if (era !== 'legacy') expect(client.getNegotiatedProtocolVersion()).toBe(era)
  return client
}

function accept(): Answer {
  return { action: 'accept', content: { confirm: true } }
}

// Les clients ne suivent pas tous la spec 2026-07-28 : les garanties valent sur les deux ères.
describe.each<Era>(['2026-07-28', 'legacy'])('serveur MCP, protocole %s', (era) => {
  let provider: CountingProvider

  beforeEach(() => {
    provider = new CountingProvider('XOF')
  })

  it('expose les cinq outils, avec leur schéma de sortie', async () => {
    const client = await connect(era, provider, 'sandbox')
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'check_account',
      'get_balance',
      'get_payment_status',
      'list_payment_methods',
      'request_payment',
    ])
    for (const tool of tools) expect(tool.outputSchema).toBeDefined()
  })

  it('n’expose pas une opération qu’aucun fournisseur ne porte', async () => {
    class PaymentsOnly extends FakeProvider {
      override readonly capabilities = {
        ...new FakeProvider('XOF').capabilities,
        operations: ['requestPayment'] as const,
      }
    }
    const client = await connect(era, new PaymentsOnly('XOF'), 'sandbox')
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain('get_balance')
    expect(names).not.toContain('check_account')
  })

  describe('confirmation', () => {
    it('montre montant, numéro masqué et motif, puis paie après accord', async () => {
      const messages: string[] = []
      const client = await connect(era, provider, 'production', (message) => {
        messages.push(message)
        return accept()
      })
      const result = await client.callTool({ name: 'request_payment', arguments: args })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({ reference: 'CMD-1', status: 'pending' })
      expect(provider.sent).toBe(1)
      expect(messages[0]).toContain('+229 01 97 •• •• 45')
      expect(messages[0]).toContain('Commande Dantokpa')
      expect(messages[0]).toMatch(/1\s500/)
      expect(messages[0]).not.toContain('0197000045')
    })

    it.each<[string, Answer]>([
      ['un refus', { action: 'decline' }],
      ['une réponse négative', { action: 'accept', content: { confirm: false } }],
    ])('n’envoie rien après %s', async (_label, answer) => {
      const client = await connect(era, provider, 'production', () => answer)
      const result = await client.callTool({ name: 'request_payment', arguments: args })
      expect(result.isError).toBe(true)
      expect(provider.sent).toBe(0)
    })

    it('ne redemande pas d’accord pour une référence rejouée', async () => {
      let asked = 0
      const client = await connect(era, provider, 'production', () => {
        asked++
        return accept()
      })
      await client.callTool({ name: 'request_payment', arguments: args })
      await client.callTool({ name: 'request_payment', arguments: args })
      expect(asked).toBe(1)
      expect(provider.sent).toBe(1)
    })

    it('ne dérange personne pour une demande déjà vouée au refus', async () => {
      let asked = 0
      const client = await connect(era, provider, 'production', () => {
        asked++
        return accept()
      })
      const result = await client.callTool({
        name: 'request_payment',
        arguments: { ...args, amount: 50001 },
      })
      expect(result.isError).toBe(true)
      expect(asked).toBe(0)
    })

    it('paie directement en sandbox si le client ne sait pas confirmer', async () => {
      const client = await connect(era, provider, 'sandbox')
      const result = await client.callTool({ name: 'request_payment', arguments: args })
      expect(result.isError).toBeFalsy()
      expect(provider.sent).toBe(1)
    })

    it('refuse hors sandbox si le client ne sait pas confirmer', async () => {
      const client = await connect(era, provider, 'production')
      const result = await client.callTool({ name: 'request_payment', arguments: args })
      expect(result.isError).toBe(true)
      expect(provider.sent).toBe(0)
    })
  })

  describe('sorties', () => {
    it('ne laisse jamais sortir le numéro complet', async () => {
      const client = await connect(era, provider, 'sandbox')
      const paid = await client.callTool({ name: 'request_payment', arguments: args })
      const recent = await client.readResource({ uri: 'payments://recent' })
      const detail = await client.readResource({ uri: 'payments://CMD-1' })
      const account = await client.callTool({ name: 'check_account', arguments: { phone: args.phone } })
      for (const output of [paid, recent, detail, account]) {
        expect(JSON.stringify(output)).not.toContain('97000045')
      }
    })

    it('rend une erreur métier lisible, sans la lever', async () => {
      const client = await connect(era, provider, 'sandbox')
      const result = await client.callTool({ name: 'get_payment_status', arguments: { reference: 'NOPE' } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('PAYMENT_NOT_FOUND')
    })

    it('suit un paiement jusqu’à son issue et donne le solde', async () => {
      const client = await connect(era, provider, 'sandbox')
      await client.callTool({ name: 'request_payment', arguments: args })
      const status = await client.callTool({ name: 'get_payment_status', arguments: { reference: 'CMD-1' } })
      expect(status.structuredContent).toMatchObject({ status: 'successful' })
      const balance = await client.callTool({ name: 'get_balance', arguments: {} })
      expect(balance.structuredContent).toMatchObject({
        balances: [{ providerId: 'fake', balance: { minorUnits: 1500, currency: 'XOF' } }],
      })
    })

    it('dit la cause d’un échec et la suite à donner, sans la laisser sur un succès', async () => {
      const client = await connect(era, provider, 'sandbox')
      await client.callTool({ name: 'request_payment', arguments: { ...args, phone: '0197000040' } })
      const failed = await client.callTool({ name: 'get_payment_status', arguments: { reference: 'CMD-1' } })
      expect(failed.structuredContent).toMatchObject({
        status: 'failed',
        failure: {
          reason: 'possibly_insufficient_funds',
          advice: expect.stringContaining('nouvelle référence'),
        },
      })

      await client.callTool({ name: 'request_payment', arguments: { ...args, reference: 'CMD-2' } })
      const paid = await client.callTool({ name: 'get_payment_status', arguments: { reference: 'CMD-2' } })
      expect(paid.structuredContent).toMatchObject({ status: 'successful', failure: null })
    })

    it('prépare le message de relance', async () => {
      const client = await connect(era, provider, 'sandbox')
      await client.callTool({ name: 'request_payment', arguments: args })
      const prompt = await client.getPrompt({ name: 'relance_paiement', arguments: { reference: 'CMD-1' } })
      expect(JSON.stringify(prompt.messages)).toContain('CMD-1')
    })
  })
})

// Au niveau du protocole, là où un client hostile peut tout écrire.
describe('confirmation face à un client hostile', () => {
  const PROTOCOL = '2026-07-28'
  let provider: CountingProvider
  let call: (params: Record<string, unknown>) => Promise<{
    result?: Record<string, unknown>
    error?: { code: number; message: string }
  }>

  beforeEach(async () => {
    provider = new CountingProvider('XOF')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    serveStdio(() => buildServer(provider, 'production'), { transport: serverSide })
    const waiting = new Map<number, (message: never) => void>()
    clientSide.onmessage = (message) => {
      const reply = message as { id?: number }
      if (reply.id !== undefined) waiting.get(reply.id)?.(message as never)
    }
    await clientSide.start()
    let nextId = 1
    call = (params) =>
      new Promise((resolve) => {
        const id = nextId++
        waiting.set(id, resolve as never)
        void clientSide.send({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'request_payment',
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL,
              'io.modelcontextprotocol/clientInfo': { name: 'hostile', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
            },
          },
        })
      })
  })

  const accepted = { confirm: { action: 'accept', content: { confirm: true } } }

  async function firstRound(): Promise<string> {
    const { result } = await call({ arguments: args })
    expect(result?.resultType).toBe('input_required')
    return result?.requestState as string
  }

  it('n’accepte pas un accord sans état signé', async () => {
    const { result } = await call({ arguments: args, inputResponses: accepted })
    expect(result?.resultType).toBe('input_required')
    expect(provider.sent).toBe(0)
  })

  it('accepte le vrai parcours', async () => {
    const requestState = await firstRound()
    const { result } = await call({ arguments: args, requestState, inputResponses: accepted })
    expect(result?.isError).toBeFalsy()
    expect(provider.sent).toBe(1)
  })

  it('rejette un état falsifié', async () => {
    const requestState = await firstRound()
    const { error } = await call({
      arguments: args,
      requestState: `${requestState.slice(0, -4)}AAAA`,
      inputResponses: accepted,
    })
    expect(error?.code).toBe(-32602)
    expect(provider.sent).toBe(0)
  })

  it('ne reporte pas un accord sur un autre montant', async () => {
    const requestState = await firstRound()
    const { result } = await call({
      arguments: { ...args, amount: 40000 },
      requestState,
      inputResponses: accepted,
    })
    expect(result?.isError).toBe(true)
    expect(provider.sent).toBe(0)
  })

  it('ne laisse pas un même accord servir deux fois', async () => {
    const requestState = await firstRound()
    await call({ arguments: args, requestState, inputResponses: accepted })
    const other = { ...args, reference: 'CMD-2' }
    const { result } = await call({ arguments: other, requestState, inputResponses: accepted })
    expect(result?.isError).toBe(true)
    expect(provider.sent).toBe(1)
  })

  it('ne rouvre pas un accord refusé', async () => {
    const requestState = await firstRound()
    await call({ arguments: args, requestState, inputResponses: { confirm: { action: 'decline' } } })
    const { result } = await call({ arguments: args, requestState, inputResponses: accepted })
    expect(result?.isError).toBe(true)
    expect(provider.sent).toBe(0)
  })
})
