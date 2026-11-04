import { describe, expect, it } from 'vitest'
import { assemble } from '../../src/assemble.js'
import { loadConfig } from '../../src/config.js'

const secret = 's'.repeat(32)

describe('configuration', () => {
  it('démarre en sandbox avec le fournisseur fake par défaut', () => {
    const config = loadConfig({})
    expect(config.PAY_ENV).toBe('sandbox')
    expect(config.PAY_PROVIDERS).toBe('fake')
  })

  it('exige le secret hors sandbox', () => {
    expect(() => loadConfig({ PAY_ENV: 'production' })).toThrow('PAY_STATE_SECRET')
  })

  it('refuse un secret trop court', () => {
    expect(() => loadConfig({ PAY_STATE_SECRET: 'court' })).toThrow('32')
  })

  it('refuse un plafond qui n’est pas un entier positif', () => {
    expect(() => loadConfig({ PAY_MAX_AMOUNT: '12.5' })).toThrow('PAY_MAX_AMOUNT')
  })

  it('refuse le fournisseur fake en production', () => {
    const config = loadConfig({ PAY_ENV: 'production', PAY_STATE_SECRET: secret, PAY_DB_PATH: ':memory:' })
    expect(() => assemble(config)).toThrow('fake')
  })

  it('exige les identifiants de mtn-momo', () => {
    expect(() => assemble(loadConfig({ PAY_PROVIDERS: 'mtn-momo', PAY_DB_PATH: ':memory:' }))).toThrow('MOMO_API_KEY')
  })

  it('exige l’adresse et l’environnement de mtn-momo hors sandbox', () => {
    const env = {
      PAY_ENV: 'production',
      PAY_STATE_SECRET: secret,
      PAY_PROVIDERS: 'mtn-momo',
      PAY_DB_PATH: ':memory:',
      MOMO_SUBSCRIPTION_KEY: 'k',
      MOMO_API_USER: 'u',
      MOMO_API_KEY: 'a',
    }
    expect(() => assemble(loadConfig(env))).toThrow('MOMO_BASE_URL')
  })

  it('refuse un fournisseur inconnu, et un pays inconnu', () => {
    expect(() => assemble(loadConfig({ PAY_PROVIDERS: 'autre', PAY_DB_PATH: ':memory:' }))).toThrow('autre')
    expect(() => assemble(loadConfig({ PAY_COUNTRY: 'XX', PAY_DB_PATH: ':memory:' }))).toThrow('XX')
  })
})
