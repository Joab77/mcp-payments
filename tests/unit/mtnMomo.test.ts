import { describe, expect, it } from 'vitest'
import { money } from '../../src/domain/money.js'
import { fromMomoAmount, toMomoAmount } from '../../src/providers/mtn-momo/amounts.js'
import { MtnMomoProvider, toMomoMessage } from '../../src/providers/mtn-momo/MtnMomoProvider.js'

type Scripted = { status: number; body?: unknown } | Error

// Rejoue les réponses mesurées sur la sandbox, sans réseau.
function harness(script: Scripted[], clock = { now: 0 }) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []
  const remaining = [...script]
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const call: (typeof calls)[number] = { url, method: String(init.method), headers }
    if (typeof init.body === 'string') call.body = init.body
    calls.push(call)
    if (url.endsWith('/collection/token/')) {
      return new Response(JSON.stringify({ access_token: `jeton-${calls.length}`, expires_in: 3600 }))
    }
    const next = remaining.shift()
    if (!next) throw new Error('réponse non prévue')
    if (next instanceof Error) throw next
    const text = next.body === undefined ? null : JSON.stringify(next.body)
    return new Response(text, { status: next.status })
  }) as typeof fetch

  const provider = new MtnMomoProvider({
    baseUrl: 'https://momo.test',
    targetEnvironment: 'sandbox',
    subscriptionKey: 'CLE-ABONNEMENT',
    apiUser: 'UTILISATEUR',
    apiKey: 'CLE-API',
    country: 'BJ',
    currency: 'EUR',
    fetch: fakeFetch,
    sleep: async () => {},
    now: () => clock.now,
  })
  const payCalls = () => calls.filter((call) => call.url.endsWith('/requesttopay'))
  return { provider, calls, payCalls }
}

const phone = { e164: '+2290197000045', countryCode: 'BJ' }
const request = {
  providerRef: 'ref-1',
  reference: 'CMD-1',
  payer: { kind: 'phone' as const, phone },
  amount: money(1250, 'EUR'),
  reason: 'Commande',
}

function remote(status: string, extra: object = {}) {
  return {
    status: 200,
    body: {
      amount: '12.5',
      currency: 'EUR',
      payer: { partyIdType: 'MSISDN', partyId: '2290197000045' },
      status,
      ...extra,
    },
  }
}

describe('montants MTN', () => {
  it.each([
    [1250, 'EUR', '12.50'],
    [5, 'EUR', '0.05'],
    [500, 'EUR', '5.00'],
    [1500, 'XOF', '1500'],
  ])('écrit %i %s en %s', (minorUnits, currency, expected) => {
    expect(toMomoAmount(money(minorUnits, currency))).toBe(expected)
  })

  it.each([
    ['5', 'EUR', 500],
    ['12.5', 'EUR', 1250],
    ['0.07', 'EUR', 7],
    ['-25', 'EUR', -2500],
    ['1500', 'XOF', 1500],
  ])('lit « %s » %s', (raw, currency, expected) => {
    expect(fromMomoAmount(raw, currency).minorUnits).toBe(expected)
  })

  it.each([['12.555', 'EUR'], ['1.5', 'XOF'], ['abc', 'EUR'], ['', 'EUR']])(
    'refuse « %s » %s',
    (raw, currency) => {
      expect(() => fromMomoAmount(raw, currency)).toThrowError(
        expect.objectContaining({ code: 'INVALID_AMOUNT' }),
      )
    },
  )
})

describe('toMomoMessage', () => {
  it.each([
    ["Commande d'Ayélé", 'Commande d Ayélé'],
    ['Commande n°12 (urgent) !', 'Commande n 12 urgent'],
    ['Réglée à Cotonou, 12/10 : ok', 'Réglée à Cotonou, 12/10 : ok'],
    ['!!!', 'Paiement'],
  ])('nettoie « %s »', (raw, expected) => {
    expect(toMomoMessage(raw)).toBe(expected)
  })
})

describe('MtnMomoProvider', () => {
  it('envoie la demande comme MTN l’attend', async () => {
    const { provider, payCalls } = harness([{ status: 202 }])
    const created = await provider.requestPayment(request)
    const call = payCalls()[0]!

    expect(created.status).toBe('pending')
    expect(call.headers['X-Reference-Id']).toBe('ref-1')
    expect(call.headers['X-Target-Environment']).toBe('sandbox')
    expect(call.headers['Ocp-Apim-Subscription-Key']).toBe('CLE-ABONNEMENT')
    expect(JSON.parse(call.body!)).toMatchObject({
      amount: '12.50',
      currency: 'EUR',
      externalId: 'CMD-1',
      payer: { partyIdType: 'MSISDN', partyId: '2290197000045' },
    })
  })

  it.each([
    ['CREATED', {}, 'pending'],
    ['PENDING', {}, 'pending'],
    ['SUCCESSFUL', {}, 'successful'],
    ['FAILED', { reason: 'APPROVAL_REJECTED' }, 'failed'],
    ['FAILED', { reason: 'EXPIRED' }, 'expired'],
  ])('traduit %s %j en %s', async (status, extra, expected) => {
    const { provider } = harness([remote(status, extra)])
    expect((await provider.getPayment('ref-1')).status).toBe(expected)
  })

  it.each([
    ['APPROVAL_REJECTED', 'payer_rejected'],
    ['PAYER_NOT_FOUND', 'payer_not_found'],
    ['COULD_NOT_PERFORM_TRANSACTION', 'timed_out'],
    ['INTERNAL_PROCESSING_ERROR', 'possibly_insufficient_funds'],
    ['NOT_ALLOWED', 'not_allowed'],
    ['SERVICE_UNAVAILABLE', 'service_unavailable'],
    ['CODE_JAMAIS_VU', 'unknown'],
  ])('traduit la raison %s en %s, sans perdre le code', async (code, reason) => {
    const { provider } = harness([remote('FAILED', { reason: code })])
    expect((await provider.getPayment('ref-1')).failure).toEqual({ reason, providerCode: code })
  })

  it('ne donne aucune cause à un paiement réussi', async () => {
    const { provider } = harness([remote('SUCCESSFUL')])
    expect((await provider.getPayment('ref-1')).failure).toBeNull()
  })

  it('tient un statut inconnu pour une issue inconnue, sans l’inventer', async () => {
    const { provider } = harness([remote('BIZARRE')])
    await expect(provider.getPayment('ref-1')).rejects.not.toHaveProperty('code')
  })

  it('reprend le paiement existant sur un 409 identique', async () => {
    const { provider } = harness([{ status: 409, body: { code: 'RESOURCE_ALREADY_EXIST' } }, remote('PENDING')])
    expect((await provider.requestPayment(request)).providerRef).toBe('ref-1')
  })

  it('refuse un 409 qui désigne un autre montant', async () => {
    const { provider } = harness([
      { status: 409, body: { code: 'RESOURCE_ALREADY_EXIST' } },
      remote('PENDING', { amount: '99' }),
    ])
    await expect(provider.requestPayment(request)).rejects.toMatchObject({ code: 'PAYMENT_CONFLICT' })
  })

  it('traduit le refus de devise et un paiement inconnu', async () => {
    const { provider } = harness([
      { status: 500, body: { code: 'INVALID_CURRENCY' } },
      { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } },
    ])
    await expect(provider.requestPayment(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CURRENCY' })
    await expect(provider.getPayment('ref-x')).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' })
  })

  it('tient la page HTML du pare-feu, en 200, pour un refus certain', async () => {
    const { provider } = harness([{ status: 200 }])
    await expect(provider.requestPayment(request)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' })
  })

  it.each(['NOT_ALLOWED', 'NOT_ALLOWED_TARGET_ENVIRONMENT', 'INVALID_CALLBACK_URL_HOST'])(
    'tient un 500 %s pour un refus certain',
    async (code) => {
      const { provider } = harness([{ status: 500, body: { code } }])
      await expect(provider.requestPayment(request)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' })
    },
  )

  it('garde un 500 INTERNAL_PROCESSING_ERROR pour une issue inconnue', async () => {
    const { provider } = harness([{ status: 500, body: { code: 'INTERNAL_PROCESSING_ERROR' } }])
    await expect(provider.requestPayment(request)).rejects.not.toHaveProperty('code')
  })

  it('n’envoie à MTN que le message nettoyé', async () => {
    const { provider, payCalls } = harness([{ status: 202 }])
    await provider.requestPayment({ ...request, reason: "Commande d'Ayélé !" })
    expect(JSON.parse(payCalls()[0]!.body!)).toMatchObject({
      payerMessage: 'Commande d Ayélé',
      payeeNote: 'Commande d Ayélé',
    })
  })

  it('tient un 400 pour un refus certain', async () => {
    const { provider } = harness([{ status: 400, body: { code: 'PAYER_NOT_FOUND' } }])
    await expect(provider.requestPayment(request)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' })
  })

  it.each([
    ['un 500', { status: 500 }],
    ['un 429', { status: 429 }],
    ['une coupure', new Error('réseau')],
  ])('ne réessaie jamais une création après %s', async (_label, failure) => {
    const { provider, payCalls } = harness([failure])
    const error = await provider.requestPayment(request).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('code')
    expect(payCalls()).toHaveLength(1)
  })

  it('réessaie une consultation sur 5xx, 429 et coupure', async () => {
    const { provider } = harness([{ status: 503 }, new Error('réseau'), remote('SUCCESSFUL')])
    expect((await provider.getPayment('ref-1')).status).toBe('successful')
  })

  it('finit par abandonner une consultation', async () => {
    const { provider } = harness([{ status: 503 }, { status: 503 }, { status: 503 }])
    await expect(provider.getPayment('ref-1')).rejects.toThrow('503')
  })

  it('garde le jeton, puis le renouvelle une minute avant son expiration', async () => {
    const clock = { now: 0 }
    const { provider, calls } = harness([remote('PENDING'), remote('PENDING'), remote('PENDING')], clock)
    const tokenCalls = () => calls.filter((call) => call.url.endsWith('/token/')).length

    await provider.getPayment('ref-1')
    clock.now = 3_539_000
    await provider.getPayment('ref-1')
    expect(tokenCalls()).toBe(1)

    clock.now = 3_540_000
    await provider.getPayment('ref-1')
    expect(tokenCalls()).toBe(2)
  })

  it('renouvelle le jeton sur un 401, et rejoue une création qui n’a pas été traitée', async () => {
    const { provider, payCalls } = harness([{ status: 401 }, { status: 202 }])
    expect((await provider.requestPayment(request)).status).toBe('pending')
    expect(payCalls()).toHaveLength(2)
    expect(payCalls()[0]!.headers.Authorization).not.toBe(payCalls()[1]!.headers.Authorization)
  })

  it('accepte un solde négatif, et lit un compte absent comme inactif', async () => {
    const { provider } = harness([
      { status: 200, body: { availableBalance: '-25', currency: 'EUR' } },
      { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } },
      { status: 200, body: { result: true } },
    ])
    expect((await provider.getBalance()).minorUnits).toBe(-2500)
    expect(await provider.checkAccount(phone)).toEqual({ active: false, operator: null })
    expect(await provider.checkAccount(phone)).toEqual({ active: true, operator: 'mtn' })
  })

  it('ne met aucune clé dans un message d’erreur', async () => {
    const { provider } = harness([{ status: 500 }])
    const error = (await provider.requestPayment(request).catch((caught: unknown) => caught)) as Error
    for (const secret of ['CLE-ABONNEMENT', 'UTILISATEUR', 'CLE-API']) {
      expect(error.message).not.toContain(secret)
    }
  })
})
