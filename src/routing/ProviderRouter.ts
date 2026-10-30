import { DomainError } from '../domain/errors.js'
import type { Currency } from '../domain/money.js'
import type { Payer } from '../domain/payment.js'
import type { PaymentProvider, ProviderOperation } from '../providers/PaymentProvider.js'

export interface RouteQuery {
  readonly country: string
  readonly operation: ProviderOperation
  readonly payerKind?: Payer['kind']
  readonly currency?: Currency
}

function canServe(provider: PaymentProvider, query: RouteQuery): boolean {
  const { countries, operations, payerKinds, currencies } = provider.capabilities
  if (!countries.includes(query.country)) return false
  if (!operations.includes(query.operation)) return false
  if (query.payerKind && !payerKinds.includes(query.payerKind)) return false
  if (query.currency && !currencies.includes(query.currency)) return false
  return true
}

export class ProviderRouter {
  constructor(private readonly providers: readonly PaymentProvider[]) {}

  // Le premier fournisseur configuré qui convient : l'ordre de configuration fait la priorité.
  find(query: RouteQuery): PaymentProvider | undefined {
    return this.providers.find((provider) => canServe(provider, query))
  }

  pick(query: RouteQuery): PaymentProvider {
    const provider = this.find(query)
    if (!provider) {
      throw new DomainError(
        'NO_PROVIDER',
        `Aucun fournisseur pour ${query.operation} (${query.country}, ${query.currency ?? 'toute devise'})`,
      )
    }
    return provider
  }

  byId(id: string): PaymentProvider | undefined {
    return this.providers.find((provider) => provider.id === id)
  }

  all(): readonly PaymentProvider[] {
    return this.providers
  }
}
