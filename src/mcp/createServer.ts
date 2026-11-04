import {
  acceptedContent,
  inputRequired,
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { PaymentDemand, PaymentService } from '../app/PaymentService.js'
import type { CountryProfile } from '../domain/country.js'
import { DomainError } from '../domain/errors.js'
import { maskPhoneNumber, parsePhoneNumber } from '../domain/phone.js'
import {
  ConfirmationLedger,
  createConfirmationCodec,
  digestOf,
  type ConfirmationState,
} from './confirmation.js'
import { formatMoney, moneyOutput, paymentOutput, presentMoney, presentPayment } from './presenters.js'

const SERVER_INFO = { name: 'mcp-mobile-money', version: '0.1.0' }
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const RECENT_PAYMENTS = 20

const confirmationAnswer = z.object({
  confirm: z.boolean().meta({ title: 'Confirmer ce paiement' }),
})

export interface ServerDependencies {
  readonly service: PaymentService
  readonly country: CountryProfile
  readonly environment: 'sandbox' | 'production'
  readonly stateSecret: string
  readonly logger: Logger
  // Partagé entre instances : serveStdio peut en créer une par ère du protocole.
  readonly ledger: ConfirmationLedger
}

function structured<T extends Record<string, unknown>>(content: T): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content }
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function canAskUser(ctx: ServerContext, server: McpServer): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  // Sur l'ancien protocole, les capacités viennent du handshake et non de la requête.
  const declared = (envelope?.[CLIENT_CAPABILITIES_KEY] ?? server.server.getClientCapabilities()) as
    | { elicitation?: { form?: object; url?: object } }
    | undefined
  const elicitation = declared?.elicitation
  if (!elicitation) return false
  // Un objet vide vaut « form » ; seul un client qui n'annonce que « url » ne peut pas répondre.
  return Boolean(elicitation.form) || !elicitation.url
}

export function createServer(deps: ServerDependencies): McpServer {
  const { service, country, environment, logger, ledger } = deps
  const codec = createConfirmationCodec(deps.stateSecret)

  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    requestState: { verify: codec.verify },
  })

  // Une erreur inattendue peut porter un détail interne : le modèle n'en reçoit jamais le texte.
  async function guarded(tool: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof DomainError) {
        logger.info({ tool, code: error.code }, 'demande refusée')
        return failure(`${error.code} : ${error.message}`)
      }
      logger.error({ tool, err: error }, 'erreur inattendue')
      return failure('INTERNAL_ERROR : le serveur a rencontré une erreur')
    }
  }

  const methods = service.listPaymentMethods()
  const offers = (operation: string) =>
    methods.providers.some((provider) => provider.operations.some((name) => name === operation))

  server.registerTool(
    'list_payment_methods',
    {
      description: 'Pays, opérateurs et opérations disponibles avec la configuration en cours.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        country: z.string(),
        environment: z.string(),
        defaultCurrency: z.string(),
        providers: z.array(
          z.object({
            id: z.string(),
            operators: z.array(z.string()),
            currencies: z.array(z.string()),
            operations: z.array(z.string()),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async () =>
      structured({
        country: methods.country,
        environment,
        defaultCurrency: methods.defaultCurrency,
        providers: methods.providers.map((provider) => ({
          id: provider.id,
          operators: [...provider.operators],
          currencies: [...provider.currencies],
          operations: [...provider.operations],
        })),
      }),
  )

  if (offers('requestPayment')) {
    server.registerTool(
      'request_payment',
      {
        description:
          "Demande un paiement à un numéro de téléphone. Le client valide sur son téléphone, en général sous 5 minutes : à l'issue de cet appel, le paiement est le plus souvent en attente. Suivre avec get_payment_status. La référence vient du marchand et rend l'appel rejouable sans double paiement.",
        inputSchema: z.object({
          reference: z.string().describe('Référence marchande stable, par exemple CMD-2026-0412'),
          phone: z.string().describe('Numéro du payeur, par exemple 0197000045 ou +2290197000045'),
          amount: z
            .number()
            .int()
            .positive()
            .describe('Entier dans la plus petite unité de la devise : 1500 XOF, ou 1250 pour 12,50 EUR'),
          reason: z.string().trim().min(1).max(160).describe('Motif affiché au payeur'),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional()
            .describe('Code ISO 4217. Sans ce champ, la devise par défaut du pays'),
        }),
        outputSchema: paymentOutput,
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args, ctx) => {
        const demand: PaymentDemand = {
          reference: args.reference,
          phone: args.phone,
          minorUnits: args.amount,
          reason: args.reason,
          ...(args.currency ? { currency: args.currency } : {}),
        }

        const run = async (): Promise<CallToolResult | ReturnType<typeof inputRequired>> => {
          const prepared = await service.prepare(demand)
          const execute = async () => {
            const payment = await service.requestPayment(demand)
            logger.info(
              { tool: 'request_payment', reference: payment.reference, status: payment.status },
              'paiement traité',
            )
            return structured(presentPayment(payment, country))
          }

          // Une référence rejouée a déjà reçu son accord : on ne redemande rien.
          if (prepared.existing) return execute()

          const digest = digestOf(prepared)
          const state = ctx.mcpReq.requestState<ConfirmationState>()

          if (state) {
            // L'état est consommé avant de lire la réponse : refusé ou non, il ne resservira pas.
            if (!ledger.consume(state.nonce) || state.digest !== digest) {
              logger.warn({ reference: prepared.reference }, 'confirmation rejetée')
              return failure('CONFIRMATION_INVALID : confirmation expirée, déjà employée ou sans rapport avec ce paiement')
            }
            const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmationAnswer)
            if (answer?.confirm !== true) {
              logger.info({ reference: prepared.reference }, 'paiement refusé par l’utilisateur')
              return failure("CONFIRMATION_DECLINED : l'utilisateur n'a pas confirmé ce paiement")
            }
            return execute()
          }

          if (!canAskUser(ctx, server)) {
            if (environment === 'sandbox') return execute()
            return failure("CONFIRMATION_UNAVAILABLE : ce client ne sait pas demander l'accord de l'utilisateur, le paiement est refusé hors sandbox")
          }

          const phone = maskPhoneNumber(prepared.payer.phone, country)
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Demander ${formatMoney(prepared.amount)} au ${phone} pour « ${prepared.reason} » (référence ${prepared.reference}) ?`,
                requestedSchema: confirmationAnswer,
              }),
            },
            requestState: await codec.mint({ nonce: ledger.issue(), digest }),
          })
        }

        try {
          return await run()
        } catch (error) {
          return guarded('request_payment', () => Promise.reject(error))
        }
      },
    )
  }

  server.registerTool(
    'get_payment_status',
    {
      description:
        'Statut à jour d’un paiement par sa référence marchande. Un échec porte sa cause et la suite à donner dans `failure`.',
      inputSchema: z.object({ reference: z.string() }),
      outputSchema: paymentOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ reference }) =>
      guarded('get_payment_status', async () =>
        structured(presentPayment(await service.getPaymentStatus(reference), country)),
      ),
  )

  if (offers('getBalance')) {
    server.registerTool(
      'get_balance',
      {
        description: 'Solde du compte marchand, par fournisseur.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          balances: z.array(z.object({ providerId: z.string(), balance: moneyOutput })),
        }),
        annotations: { readOnlyHint: true },
      },
      async () =>
        guarded('get_balance', async () => {
          const balances = await service.getBalances()
          return structured({
            balances: balances.map(({ providerId, balance }) => ({
              providerId,
              balance: presentMoney(balance),
            })),
          })
        }),
    )
  }

  if (offers('checkAccount')) {
    server.registerTool(
      'check_account',
      {
        description: 'Indique si un numéro est un compte actif, et chez quel opérateur.',
        inputSchema: z.object({ phone: z.string() }),
        outputSchema: z.object({
          phone: z.string(),
          active: z.boolean(),
          operator: z.string().nullable(),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ phone }) =>
        guarded('check_account', async () => {
          const account = await service.checkAccount(phone)
          const masked = maskPhoneNumber(parsePhoneNumber(phone, country), country)
          return structured({ phone: masked, active: account.active, operator: account.operator })
        }),
    )
  }

  server.registerResource(
    'recent_payments',
    'payments://recent',
    { description: `Les ${RECENT_PAYMENTS} derniers paiements, numéros masqués`, mimeType: 'application/json' },
    async (uri) => {
      const payments = await service.listRecent(RECENT_PAYMENTS)
      const text = JSON.stringify(payments.map((payment) => presentPayment(payment, country)))
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] }
    },
  )

  server.registerResource(
    'payment',
    new ResourceTemplate('payments://{reference}', { list: undefined }),
    { description: 'Le détail d’un paiement et son historique de statuts', mimeType: 'application/json' },
    async (uri, variables) => {
      const payment = await service.getPayment(String(variables.reference))
      const text = JSON.stringify(presentPayment(payment, country))
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] }
    },
  )

  server.registerPrompt(
    'relance_paiement',
    {
      description: 'Message de relance poli pour un paiement resté en attente, en français.',
      argsSchema: z.object({ reference: z.string() }),
    },
    async ({ reference }) => {
      const payment = await service.getPayment(reference)
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Rédige en français un court message de relance, poli et sans pression, pour un client qui n'a pas encore validé son paiement de ${formatMoney(payment.amount)} (référence ${payment.reference}, motif : ${payment.reason}, statut : ${payment.status}). Rappelle qu'il valide la demande sur son téléphone avec son code, et qu'on ne lui demandera jamais ce code.`,
            },
          },
        ],
      }
    },
  )

  return server
}
