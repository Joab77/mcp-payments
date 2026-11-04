import { randomUUID } from 'node:crypto'
import type { CountryProfile } from '../domain/country.js'
import { DomainError } from '../domain/errors.js'
import { money, type Currency, type Money } from '../domain/money.js'
import {
  applyStatus,
  createPayment,
  isSameDemand,
  parseMerchantReference,
  payerKey,
  type Payer,
  type Payment,
  type PaymentFailure,
} from '../domain/payment.js'
import { parsePhoneNumber } from '../domain/phone.js'
import { assertWithinLimits, type PaymentLimits } from '../policy/limits.js'
import type { AccountCheck, PaymentProvider } from '../providers/PaymentProvider.js'
import type { ProviderRouter } from '../routing/ProviderRouter.js'
import type { PaymentRepository } from '../store/PaymentRepository.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface PaymentServiceOptions {
  readonly country: CountryProfile
  readonly environment: 'sandbox' | 'production'
  readonly router: ProviderRouter
  readonly repository: PaymentRepository
  readonly limits: PaymentLimits
  readonly now?: () => Date
  readonly newProviderRef?: () => string
}

export interface PaymentDemand {
  readonly reference: string
  readonly phone: string
  readonly minorUnits: number
  readonly currency?: Currency
  readonly reason: string
}

export interface PreparedDemand {
  readonly reference: string
  readonly payer: Payer
  readonly amount: Money
  readonly reason: string
  // Présent quand la référence désigne déjà ce paiement : rien de nouveau à confirmer.
  readonly existing: Payment | null
}

export class PaymentService {
  private readonly country: CountryProfile
  private readonly environment: 'sandbox' | 'production'
  private readonly router: ProviderRouter
  private readonly repository: PaymentRepository
  private readonly limits: PaymentLimits
  private readonly now: () => Date
  private readonly newProviderRef: () => string
  // Vérifier les plafonds puis enregistrer doit se faire d'un bloc, sinon deux appels
  // simultanés passent chacun sous le plafond. Vaut pour une seule instance du serveur.
  private creationQueue: Promise<unknown> = Promise.resolve()

  constructor(options: PaymentServiceOptions) {
    this.country = options.country
    this.environment = options.environment
    this.router = options.router
    this.repository = options.repository
    this.limits = options.limits
    this.now = options.now ?? (() => new Date())
    this.newProviderRef = options.newProviderRef ?? randomUUID
  }

  // Tout ce qui ferait échouer la demande, vérifié avant de déranger un humain. N'écrit rien.
  async prepare(demand: PaymentDemand): Promise<PreparedDemand> {
    const { reference, payer, amount, reason } = this.normalize(demand)
    const existing = await this.repository.findByReference(reference)
    if (existing) {
      this.assertSameDemand(existing, { payer, amount, reason })
    } else {
      await this.assertLimits(amount, payer)
    }
    return { reference, payer, amount, reason, existing }
  }

  async requestPayment(demand: PaymentDemand): Promise<Payment> {
    const { provider, ...normalized } = this.normalize(demand)
    const { payment, isNew } = await this.inCreationQueue(() =>
      this.findOrCreate({ ...normalized, provider }),
    )
    if (isNew) return this.submit(payment)
    return payment.status === 'pending' ? this.reconcile(payment) : payment
  }

  async getPaymentStatus(rawReference: string): Promise<Payment> {
    const payment = await this.requirePayment(parseMerchantReference(rawReference))
    if (payment.status !== 'pending') return payment

    const provider = this.router.byId(payment.providerId)
    if (!provider) return payment
    try {
      const remote = await provider.getPayment(payment.providerRef)
      return await this.record(payment, remote.status, remote.failure)
    } catch {
      // Une consultation ratée ne dit rien du paiement : on rend ce qu'on sait.
      return payment
    }
  }

  async getBalances(): Promise<{ providerId: string; balance: Money }[]> {
    const balances: { providerId: string; balance: Money }[] = []
    for (const provider of this.router.all()) {
      if (provider.getBalance && provider.capabilities.operations.includes('getBalance')) {
        balances.push({ providerId: provider.id, balance: await provider.getBalance() })
      }
    }
    return balances
  }

  async checkAccount(rawPhone: string): Promise<AccountCheck> {
    const phone = parsePhoneNumber(rawPhone, this.country)
    const provider = this.router.pick({ country: this.country.code, operation: 'checkAccount' })
    if (!provider.checkAccount) {
      throw new DomainError('NO_PROVIDER', `${provider.id} ne sait pas vérifier un compte`)
    }
    return provider.checkAccount(phone)
  }

  listRecent(limit = 20): Promise<Payment[]> {
    return this.repository.listRecent(limit)
  }

  async getPayment(rawReference: string): Promise<Payment> {
    return this.requirePayment(parseMerchantReference(rawReference))
  }

  listPaymentMethods() {
    return {
      country: this.country.code,
      defaultCurrency: this.country.currency,
      providers: this.router.all().map((provider) => ({
        id: provider.id,
        ...provider.capabilities,
      })),
    }
  }

  private normalize(demand: PaymentDemand) {
    const payer: Payer = { kind: 'phone', phone: parsePhoneNumber(demand.phone, this.country) }
    const { provider, currency } = this.chooseProvider(demand.currency)
    const amount = money(demand.minorUnits, currency)
    if (amount.minorUnits === 0) {
      throw new DomainError('INVALID_AMOUNT', 'Un paiement ne peut pas être nul')
    }
    return {
      reference: parseMerchantReference(demand.reference),
      payer,
      amount,
      reason: demand.reason.trim(),
      provider,
    }
  }

  private assertSameDemand(
    payment: Payment,
    demand: { payer: Payer; amount: Money; reason: string },
  ): void {
    if (!isSameDemand(payment, demand)) {
      throw new DomainError(
        'PAYMENT_CONFLICT',
        `La référence ${payment.reference} désigne déjà un autre paiement`,
      )
    }
  }

  private chooseProvider(requested?: Currency): { provider: PaymentProvider; currency: Currency } {
    const route = {
      country: this.country.code,
      operation: 'requestPayment',
      payerKind: 'phone',
    } as const

    if (requested) {
      return { provider: this.router.pick({ ...route, currency: requested }), currency: requested }
    }

    const countryCurrency = this.country.currency
    const provider = this.router.find({ ...route, currency: countryCurrency })
    if (provider) return { provider, currency: countryCurrency }

    // En sandbox seulement, le fournisseur impose sa devise (l'euro chez MTN).
    const sandboxProvider = this.environment === 'sandbox' ? this.router.find(route) : undefined
    const sandboxCurrency = sandboxProvider?.capabilities.currencies[0]
    if (sandboxProvider && sandboxCurrency) {
      return { provider: sandboxProvider, currency: sandboxCurrency }
    }
    return { provider: this.router.pick({ ...route, currency: countryCurrency }), currency: countryCurrency }
  }

  private inCreationQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.creationQueue.then(task, task)
    this.creationQueue = run.catch(() => undefined)
    return run
  }

  private async findOrCreate(input: {
    reference: string
    payer: Payer
    amount: Money
    reason: string
    provider: PaymentProvider
  }): Promise<{ payment: Payment; isNew: boolean }> {
    const existing = await this.repository.findByReference(input.reference)
    if (existing) {
      this.assertSameDemand(existing, input)
      return { payment: existing, isNew: false }
    }

    await this.assertLimits(input.amount, input.payer)

    // Enregistré avant l'envoi : si tout coupe ensuite, le lien avec le fournisseur survit.
    const payment = createPayment(
      {
        reference: input.reference,
        providerId: input.provider.id,
        providerRef: this.newProviderRef(),
        payer: input.payer,
        amount: input.amount,
        reason: input.reason,
      },
      this.now(),
    )
    await this.repository.insert(payment)
    return { payment, isNew: true }
  }

  private async assertLimits(amount: Money, payer: Payer): Promise<void> {
    const since = new Date(this.now().getTime() - ONE_DAY_MS)
    const [merchantTotal, payerTotal] = await Promise.all([
      this.repository.totalRequestedSince({ since, currency: amount.currency }),
      this.repository.totalRequestedSince({
        since,
        currency: amount.currency,
        payerKey: payerKey(payer),
      }),
    ])
    assertWithinLimits(amount, { merchantTotal, payerTotal }, this.limits)
  }

  private async submit(payment: Payment): Promise<Payment> {
    const provider = this.requireProvider(payment)
    try {
      const remote = await provider.requestPayment({
        providerRef: payment.providerRef,
        reference: payment.reference,
        payer: payment.payer,
        amount: payment.amount,
        reason: payment.reason,
      })
      return await this.record(payment, remote.status, remote.failure)
    } catch (error) {
      if (error instanceof DomainError) {
        await this.record(payment, 'failed', { reason: 'provider_refused', providerCode: error.code })
        throw error
      }
      // La demande est peut-être arrivée : surtout pas de nouvel envoi à l'aveugle.
      return this.lookUpAfterUnknownOutcome(payment, provider)
    }
  }

  private async lookUpAfterUnknownOutcome(
    payment: Payment,
    provider: PaymentProvider,
  ): Promise<Payment> {
    try {
      const remote = await provider.getPayment(payment.providerRef)
      return await this.record(payment, remote.status, remote.failure)
    } catch {
      return payment
    }
  }

  // Une référence rejouée alors que le paiement attend encore. Renvoyer la demande n'est
  // permis que si le fournisseur dit ne pas la connaître, et toujours avec le même providerRef.
  private async reconcile(payment: Payment): Promise<Payment> {
    const provider = this.requireProvider(payment)
    try {
      const remote = await provider.getPayment(payment.providerRef)
      return await this.record(payment, remote.status, remote.failure)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PAYMENT_NOT_FOUND') {
        return this.submit(payment)
      }
      return payment
    }
  }

  private async record(
    payment: Payment,
    status: Payment['status'],
    failure?: PaymentFailure | null,
  ): Promise<Payment> {
    const updated = applyStatus(payment, status, this.now(), failure ?? null)
    if (updated !== payment) await this.repository.save(updated)
    return updated
  }

  private requireProvider(payment: Payment): PaymentProvider {
    const provider = this.router.byId(payment.providerId)
    if (!provider) {
      throw new DomainError('NO_PROVIDER', `Fournisseur non configuré : ${payment.providerId}`)
    }
    return provider
  }

  private async requirePayment(reference: string): Promise<Payment> {
    const payment = await this.repository.findByReference(reference)
    if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', `Paiement inconnu : ${reference}`)
    return payment
  }
}
