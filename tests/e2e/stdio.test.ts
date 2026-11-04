import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Le vrai binaire, un vrai client : si un log touche stdout, ces tests tombent.
describe.each(['2026-07-28', 'legacy'] as const)('serveur compilé en stdio, protocole %s', (era) => {
  let folder: string
  let client: Client

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'mcp-payments-africa-e2e-'))
    client = new Client(
      { name: 'e2e', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: era } },
      },
    )
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { confirm: true },
    }))
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/index.js'],
        env: { PAY_PROVIDERS: 'fake', PAY_DB_PATH: join(folder, 'e2e.db') },
      }),
    )
  })

  afterEach(async () => {
    await client.close()
    rmSync(folder, { recursive: true, force: true })
  })

  it('confirme, encaisse et suit un paiement de bout en bout', async () => {
    const created = await client.callTool({
      name: 'request_payment',
      arguments: { reference: 'E2E-1', phone: '01 97 00 00 45', amount: 1500, reason: 'Essai' },
    })
    expect(created.isError).toBeFalsy()
    if (era !== 'legacy') expect(client.getNegotiatedProtocolVersion()).toBe(era)
    const status = await client.callTool({
      name: 'get_payment_status',
      arguments: { reference: 'E2E-1' },
    })
    expect(status.structuredContent).toMatchObject({
      status: 'successful',
      phone: '+229 01 97 •• •• 45',
    })
  })
})
