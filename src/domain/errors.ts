export type DomainErrorCode =
  | 'INVALID_PHONE'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'UNSUPPORTED_CURRENCY'
  | 'INVALID_REFERENCE'
  | 'INVALID_TRANSITION'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_CONFLICT'
  | 'LIMIT_EXCEEDED'
  | 'NO_PROVIDER'
  | 'PROVIDER_REJECTED'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
