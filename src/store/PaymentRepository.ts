import type { Currency } from '../domain/money.js'
import type { Payment } from '../domain/payment.js'

export interface SpendingQuery {
  readonly since: Date
  readonly currency: Currency
  // Sans payeur, le total couvre tout le compte marchand.
  readonly payerKey?: string
}

// Asynchrone même si SQLite ne l'est pas : Postgres ou MySQL entrent par le même contrat.
export interface PaymentRepository {
  // Lève PAYMENT_CONFLICT si la référence existe déjà.
  insert(payment: Payment): Promise<void>
  save(payment: Payment): Promise<void>
  findByReference(reference: string): Promise<Payment | null>
  listRecent(limit: number): Promise<Payment[]>
  // Somme ce qui est réussi ou encore en attente : un échec ne consomme aucun plafond.
  totalRequestedSince(query: SpendingQuery): Promise<number>
}
