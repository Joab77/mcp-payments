import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PaymentService } from './app/PaymentService.js'
import type { ServerConfig } from './config.js'
import { BJ } from './countries/BJ.js'
import type { CountryProfile } from './domain/country.js'
import type { PaymentLimits } from './policy/limits.js'
import { FakeProvider } from './providers/fake/FakeProvider.js'
import { MtnMomoProvider } from './providers/mtn-momo/MtnMomoProvider.js'
import type { PaymentProvider } from './providers/PaymentProvider.js'
import { ProviderRouter } from './routing/ProviderRouter.js'
import { SqlitePaymentRepository } from './store/sqlite/SqlitePaymentRepository.js'

const COUNTRIES: Readonly<Record<string, CountryProfile>> = { BJ }

function buildProvider(id: string, country: CountryProfile, config: ServerConfig): PaymentProvider {
  if (id === 'fake') {
    if (config.PAY_ENV !== 'sandbox') {
      throw new Error('Le fournisseur fake est réservé à la sandbox')
    }
    return new FakeProvider(country.currency)
  }
  if (id === 'mtn-momo') return buildMtnMomo(country, config)
  throw new Error(`Fournisseur non disponible : ${id}`)
}

function buildMtnMomo(country: CountryProfile, config: ServerConfig): PaymentProvider {
  const { MOMO_SUBSCRIPTION_KEY, MOMO_API_USER, MOMO_API_KEY } = config
  if (!MOMO_SUBSCRIPTION_KEY || !MOMO_API_USER || !MOMO_API_KEY) {
    throw new Error('mtn-momo exige MOMO_SUBSCRIPTION_KEY, MOMO_API_USER et MOMO_API_KEY')
  }
  const credentials = {
    subscriptionKey: MOMO_SUBSCRIPTION_KEY,
    apiUser: MOMO_API_USER,
    apiKey: MOMO_API_KEY,
  }

  if (config.PAY_ENV === 'sandbox') {
    // La sandbox n'accepte que l'euro, quel que soit le pays (mesuré : XOF répond 500).
    return new MtnMomoProvider({
      ...credentials,
      baseUrl: 'https://sandbox.momodeveloper.mtn.com',
      targetEnvironment: 'sandbox',
      country: country.code,
      currency: 'EUR',
    })
  }

  if (!config.MOMO_BASE_URL || !config.MOMO_TARGET_ENV) {
    throw new Error('mtn-momo exige MOMO_BASE_URL et MOMO_TARGET_ENV hors sandbox')
  }
  return new MtnMomoProvider({
    ...credentials,
    baseUrl: config.MOMO_BASE_URL,
    targetEnvironment: config.MOMO_TARGET_ENV,
    country: country.code,
    currency: country.currency,
  })
}

// Le plafond vaut dans la devise du pays. Hors sandbox, toute autre devise reste donc refusée.
function buildLimits(
  config: ServerConfig,
  country: CountryProfile,
  providers: readonly PaymentProvider[],
): PaymentLimits {
  const currencies = new Set([country.currency])
  if (config.PAY_ENV === 'sandbox') {
    for (const provider of providers) {
      for (const currency of provider.capabilities.currencies) currencies.add(currency)
    }
  }

  const limits: Record<string, PaymentLimits[string]> = {}
  for (const currency of currencies) {
    limits[currency] = {
      perPayment: config.PAY_MAX_AMOUNT,
      perDay: config.PAY_MAX_DAILY,
      perPayerPerDay: config.PAY_MAX_DAILY_PER_PAYER,
    }
  }
  return limits
}

export function assemble(config: ServerConfig) {
  const country = COUNTRIES[config.PAY_COUNTRY]
  if (!country) throw new Error(`Pays non disponible : ${config.PAY_COUNTRY}`)

  const providerIds = config.PAY_PROVIDERS.split(',').map((id) => id.trim()).filter(Boolean)
  if (providerIds.length === 0) throw new Error('PAY_PROVIDERS ne désigne aucun fournisseur')
  const providers = providerIds.map((id) => buildProvider(id, country, config))

  if (config.PAY_DB_PATH !== ':memory:') {
    mkdirSync(dirname(config.PAY_DB_PATH), { recursive: true })
  }

  const service = new PaymentService({
    country,
    environment: config.PAY_ENV,
    router: new ProviderRouter(providers),
    repository: new SqlitePaymentRepository(config.PAY_DB_PATH),
    limits: buildLimits(config, country, providers),
  })

  return {
    service,
    country,
    environment: config.PAY_ENV,
    // En sandbox sans secret : une clé jetable, valable le temps du processus.
    stateSecret: config.PAY_STATE_SECRET ?? randomBytes(32).toString('hex'),
  }
}
