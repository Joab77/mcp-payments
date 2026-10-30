#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import pino from 'pino'
import { assemble } from './assemble.js'
import { loadConfig } from './config.js'
import { ConfirmationLedger } from './mcp/confirmation.js'
import { createServer } from './mcp/createServer.js'

// stdout porte le protocole : le journal part sur stderr (descripteur 2).
const logger = pino(pino.destination(2))

try {
  const parts = assemble(loadConfig(process.env))
  const ledger = new ConfirmationLedger()
  serveStdio(() => createServer({ ...parts, logger, ledger }), {
    onerror: (error) => logger.error({ err: error }, 'erreur de transport'),
  })
  logger.info({ environment: parts.environment, country: parts.country.code }, 'serveur prêt')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
