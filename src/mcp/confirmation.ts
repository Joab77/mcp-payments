import { createHash, randomUUID } from 'node:crypto'
import { createRequestStateCodec } from '@modelcontextprotocol/server'
import type { Money } from '../domain/money.js'
import { payerKey, type Payer } from '../domain/payment.js'

const CONFIRMATION_TTL_SECONDS = 120

export interface ConfirmationState {
  readonly nonce: string
  readonly digest: string
}

// Lie l'accord humain à ce paiement précis : un accord ne se reporte pas sur un autre montant.
export function digestOf(demand: {
  reference: string
  payer: Payer
  amount: Money
  reason: string
}): string {
  const canonical = JSON.stringify([
    demand.reference,
    payerKey(demand.payer),
    demand.amount.minorUnits,
    demand.amount.currency,
    demand.reason,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

export function createConfirmationCodec(secret: string) {
  return createRequestStateCodec<ConfirmationState>({
    key: secret,
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
  })
}

// La signature prouve que l'état vient du serveur, pas qu'il n'a pas déjà servi.
export class ConfirmationLedger {
  private readonly open = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    this.dropExpired()
    const nonce = randomUUID()
    this.open.set(nonce, this.now() + CONFIRMATION_TTL_SECONDS * 1000)
    return nonce
  }

  consume(nonce: string): boolean {
    this.dropExpired()
    return this.open.delete(nonce)
  }

  private dropExpired(): void {
    const current = this.now()
    for (const [nonce, expiresAt] of this.open) {
      if (expiresAt <= current) this.open.delete(nonce)
    }
  }
}
