// Ce qu'un autre projet importe pour brancher son fournisseur, son pays ou sa base.
export { PaymentService } from './app/PaymentService.js'
export type { PaymentDemand, PaymentServiceOptions } from './app/PaymentService.js'
export type { CountryProfile, OperatorId } from './domain/country.js'
export { DomainError } from './domain/errors.js'
export type { DomainErrorCode } from './domain/errors.js'
export { money } from './domain/money.js'
export type { Currency, Money } from './domain/money.js'
export { payerKey } from './domain/payment.js'
export type { FailureReason, Payer, Payment, PaymentFailure, PaymentStatus } from './domain/payment.js'
export { maskPhoneNumber, parsePhoneNumber } from './domain/phone.js'
export type { PhoneNumber } from './domain/phone.js'
export type { PaymentLimits } from './policy/limits.js'
export type {
  AccountCheck,
  PaymentProvider,
  PaymentRequest,
  ProviderCapabilities,
  ProviderPayment,
} from './providers/PaymentProvider.js'
export { ProviderRouter } from './routing/ProviderRouter.js'
export type { PaymentRepository, SpendingQuery } from './store/PaymentRepository.js'
export { BJ } from './countries/BJ.js'
export { FakeProvider } from './providers/fake/FakeProvider.js'
export { MtnMomoProvider } from './providers/mtn-momo/MtnMomoProvider.js'
export { SqlitePaymentRepository } from './store/sqlite/SqlitePaymentRepository.js'
