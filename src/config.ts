import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const amount = z.coerce.number().int().positive()

const envSchema = z
  .object({
    PAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
    PAY_COUNTRY: z.string().default('BJ'),
    PAY_PROVIDERS: z.string().default('fake'),
    PAY_MAX_AMOUNT: amount.default(50000),
    PAY_MAX_DAILY: amount.default(200000),
    PAY_MAX_DAILY_PER_PAYER: amount.default(100000),
    PAY_STATE_SECRET: z.string().min(32, 'doit faire au moins 32 caractères').optional(),
    // Claude Desktop lance le serveur depuis son propre dossier : pas de chemin relatif par défaut.
    PAY_DB_PATH: z.string().default(join(homedir(), '.mcp-payments-africa', 'payments.db')),
    MOMO_SUBSCRIPTION_KEY: z.string().min(1).optional(),
    MOMO_API_USER: z.string().min(1).optional(),
    MOMO_API_KEY: z.string().min(1).optional(),
    // Propres au pays et au contrat, donnés par MTN pour la production.
    MOMO_BASE_URL: z.url().optional(),
    MOMO_TARGET_ENV: z.string().min(1).optional(),
  })
  .refine((env) => env.PAY_ENV === 'sandbox' || env.PAY_STATE_SECRET, {
    path: ['PAY_STATE_SECRET'],
    message: 'obligatoire hors sandbox',
  })

export type ServerConfig = z.infer<typeof envSchema>

// Un serveur mal configuré s'arrête ici, pas au premier paiement.
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = envSchema.safeParse(env)
  if (parsed.success) return parsed.data

  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} : ${issue.message}`)
  throw new Error(`Configuration invalide\n${problems.join('\n')}`)
}
