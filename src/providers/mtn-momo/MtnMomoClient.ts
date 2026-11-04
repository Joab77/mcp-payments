const TOKEN_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const READ_ATTEMPTS = 3
const BASE_DELAY_MS = 500

export interface MtnMomoClientOptions {
  readonly baseUrl: string
  readonly targetEnvironment: string
  readonly subscriptionKey: string
  readonly apiUser: string
  readonly apiKey: string
  readonly fetch?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

export interface MomoResponse {
  readonly status: number
  readonly body: unknown
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

// Le jeton, le temps limite et les nouvelles tentatives. Les messages d'erreur ne portent que
// le chemin et le code : jamais un en-tête, donc jamais une clé.
export class MtnMomoClient {
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private token: { value: string; expiresAt: number } | null = null

  constructor(private readonly options: MtnMomoClientOptions) {
    this.fetch = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  async read(path: string): Promise<MomoResponse> {
    return this.withRetries(() => this.authorized('GET', path), path)
  }

  // Une seule tentative : si elle échoue en route, on ignore si la demande est arrivée.
  async create(path: string, referenceId: string, payload: unknown): Promise<MomoResponse> {
    return this.authorized('POST', path, {
      headers: { 'X-Reference-Id': referenceId, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  private async authorized(
    method: string,
    path: string,
    extra: { headers: Record<string, string>; body: string } | null = null,
  ): Promise<MomoResponse> {
    const send = async () =>
      this.send(method, path, {
        ...extra?.headers,
        Authorization: `Bearer ${await this.accessToken()}`,
        'X-Target-Environment': this.options.targetEnvironment,
      }, extra?.body)

    const first = await send()
    if (first.status !== 401) return first
    // Un 401 prouve que la demande n'a pas été traitée : la rejouer avec un jeton neuf est sûr.
    this.token = null
    return send()
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value

    const credentials = `${this.options.apiUser}:${this.options.apiKey}`
    const path = '/collection/token/'
    const response = await this.withRetries(
      () =>
        this.send('POST', path, {
          Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
        }),
      path,
    )
    const body = response.body as { access_token?: unknown; expires_in?: unknown } | null
    if (
      response.status !== 200 ||
      typeof body?.access_token !== 'string' ||
      typeof body.expires_in !== 'number'
    ) {
      throw new Error(`MTN a refusé le jeton (${response.status})`)
    }
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + body.expires_in * 1000 - TOKEN_MARGIN_MS,
    }
    return this.token.value
  }

  private async withRetries(
    attempt: () => Promise<MomoResponse>,
    path: string,
  ): Promise<MomoResponse> {
    let lastFailure: MomoResponse | Error = new Error(`${path} : aucune tentative`)
    for (let round = 0; round < READ_ATTEMPTS; round++) {
      if (round > 0) await this.sleep(BASE_DELAY_MS * 2 ** (round - 1) * (1 + Math.random()))
      try {
        const response = await attempt()
        if (!isRetryable(response.status)) return response
        lastFailure = response
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (lastFailure instanceof Error) throw lastFailure
    return lastFailure
  }

  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<MomoResponse> {
    const response = await this.fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: { 'Ocp-Apim-Subscription-Key': this.options.subscriptionKey, ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body === undefined ? {} : { body }),
    })
    return { status: response.status, body: await readBody(response) }
  }
}
