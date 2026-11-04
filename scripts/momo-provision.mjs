// Crée l'utilisateur API de la sandbox MTN et range ses identifiants dans .env.
// La clé API ne se relit pas chez MTN, et elle n'a rien à faire dans un terminal.
import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync } from 'node:fs'

const BASE_URL = 'https://sandbox.momodeveloper.mtn.com'
const subscriptionKey = process.env.MOMO_SUBSCRIPTION_KEY

if (!subscriptionKey) {
  console.error('MOMO_SUBSCRIPTION_KEY manquante dans .env')
  process.exit(1)
}
if (process.env.MOMO_API_USER || process.env.MOMO_API_KEY) {
  console.error('.env contient déjà MOMO_API_USER ou MOMO_API_KEY : rien à faire')
  process.exit(1)
}

async function post(path, headers, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status !== 201) {
    throw new Error(`${path} a répondu ${response.status}`)
  }
  return response
}

const apiUser = randomUUID()
await post(
  '/v1_0/apiuser',
  { 'X-Reference-Id': apiUser, 'Content-Type': 'application/json' },
  { providerCallbackHost: 'localhost' },
)
const { apiKey } = await (await post(`/v1_0/apiuser/${apiUser}/apikey`)).json()

appendFileSync('.env', `MOMO_API_USER=${apiUser}\nMOMO_API_KEY=${apiKey}\n`)
chmodSync('.env', 0o600)
console.log('Utilisateur API créé, identifiants ajoutés à .env')
