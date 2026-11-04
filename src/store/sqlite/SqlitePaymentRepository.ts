import Database from 'better-sqlite3'
import { DomainError } from '../../domain/errors.js'
import {
  payerKey,
  type Payer,
  type Payment,
  type PaymentFailure,
  type PaymentStatus,
} from '../../domain/payment.js'
import type { PaymentRepository, SpendingQuery } from '../PaymentRepository.js'

interface PaymentRow {
  reference: string
  provider_id: string
  provider_ref: string
  payer: string
  amount_minor: number
  currency: string
  reason: string
  status: PaymentStatus
  failure: string | null
  history: string
}

function rowToPayment(row: PaymentRow): Payment {
  const history = JSON.parse(row.history) as { status: PaymentStatus; at: string }[]
  return {
    reference: row.reference,
    providerId: row.provider_id,
    providerRef: row.provider_ref,
    payer: JSON.parse(row.payer) as Payer,
    amount: { minorUnits: row.amount_minor, currency: row.currency },
    reason: row.reason,
    status: row.status,
    failure: row.failure ? (JSON.parse(row.failure) as PaymentFailure) : null,
    history: history.map((change) => ({ status: change.status, at: new Date(change.at) })),
  }
}

export class SqlitePaymentRepository implements PaymentRepository {
  private readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        reference    TEXT PRIMARY KEY,
        provider_id  TEXT NOT NULL,
        provider_ref TEXT NOT NULL UNIQUE,
        payer        TEXT NOT NULL,
        payer_key    TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency     TEXT NOT NULL,
        reason       TEXT NOT NULL,
        status       TEXT NOT NULL,
        history      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payments_created_at ON payments (created_at);
    `)
    // Une base créée avant l'ajout de la cause d'échec.
    const columns = this.db.pragma('table_info(payments)') as { name: string }[]
    if (!columns.some((column) => column.name === 'failure')) {
      this.db.exec('ALTER TABLE payments ADD COLUMN failure TEXT')
    }
  }

  async insert(payment: Payment): Promise<void> {
    const createdAt = payment.history[0]?.at ?? new Date()
    try {
      this.db
        .prepare(
          `INSERT INTO payments (reference, provider_id, provider_ref, payer, payer_key,
             amount_minor, currency, reason, status, failure, history, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payment.reference,
          payment.providerId,
          payment.providerRef,
          JSON.stringify(payment.payer),
          payerKey(payment.payer),
          payment.amount.minorUnits,
          payment.amount.currency,
          payment.reason,
          payment.status,
          payment.failure ? JSON.stringify(payment.failure) : null,
          JSON.stringify(payment.history),
          createdAt.toISOString(),
        )
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code.startsWith('SQLITE_CONSTRAINT')) {
        throw new DomainError('PAYMENT_CONFLICT', `Référence déjà employée : ${payment.reference}`)
      }
      throw error
    }
  }

  async save(payment: Payment): Promise<void> {
    this.db
      .prepare('UPDATE payments SET status = ?, failure = ?, history = ? WHERE reference = ?')
      .run(
        payment.status,
        payment.failure ? JSON.stringify(payment.failure) : null,
        JSON.stringify(payment.history),
        payment.reference,
      )
  }

  async findByReference(reference: string): Promise<Payment | null> {
    const row = this.db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference)
    return row ? rowToPayment(row as PaymentRow) : null
  }

  async listRecent(limit: number): Promise<Payment[]> {
    const rows = this.db
      .prepare('SELECT * FROM payments ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit)
    return (rows as PaymentRow[]).map(rowToPayment)
  }

  async totalRequestedSince(query: SpendingQuery): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
         WHERE status IN ('pending', 'successful') AND created_at >= ? AND currency = ?
           AND (? IS NULL OR payer_key = ?)`,
      )
      .get(
        query.since.toISOString(),
        query.currency,
        query.payerKey ?? null,
        query.payerKey ?? null,
      ) as { total: number }
    return row.total
  }

  close(): void {
    this.db.close()
  }
}
