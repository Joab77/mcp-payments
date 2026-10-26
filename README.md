# mcp-mobile-money

> Serveur **MCP (Model Context Protocol)** qui permet à un assistant IA (Claude, ChatGPT, Cursor, etc.) d'interagir avec les API de paiement Mobile Money (MTN MoMo, en mode sandbox) : initier un paiement, vérifier son statut, consulter le solde.

![statut](https://img.shields.io/badge/statut-en%20d%C3%A9veloppement-orange) ![licence](https://img.shields.io/badge/licence-MIT-blue)

---

## Pourquoi ce projet

Les assistants IA deviennent des interfaces de travail, mais très peu d'outils MCP existent pour les services de paiement utilisés en Afrique de l'Ouest. Ce serveur comble ce manque. Il sert aussi de référence propre pour construire un serveur MCP sécurisé autour d'une API financière : validation stricte des entrées, confirmation humaine, idempotence et journalisation.

## Fonctionnalités

| Outil MCP | Description |
|---|---|
| `request_to_pay` | Initie une demande de paiement vers un numéro (montant, devise, référence) |
| `get_payment_status` | Renvoie le statut d'une transaction (`PENDING`, `SUCCESSFUL`, `FAILED`) |
| `get_account_balance` | Renvoie le solde du compte marchand |
| `validate_account` | Vérifie qu'un numéro est un compte Mobile Money actif |

| Ressource MCP | Description |
|---|---|
| `momo://transactions/recent` | Les 20 dernières transactions initiées par le serveur |

| Prompt MCP | Description |
|---|---|
| `relance_paiement` | Modèle de message de relance pour un paiement en attente |

## Architecture

```
Client MCP (Claude Desktop, Cursor...)
        │  JSON-RPC 2.0 (stdio ou Streamable HTTP)
        ▼
┌─────────────────────────────┐
│  Serveur MCP                │
│  ├─ tools/      (Zod/Pydantic : validation des entrées)
│  ├─ resources/              │
│  ├─ prompts/                │
│  ├─ momo-client/            │  OAuth2 client credentials, retries, idempotence
│  └─ store/ (SQLite)         │  journal des transactions
└─────────────────────────────┘
        │  HTTPS
        ▼
API MTN MoMo (sandbox)
```

## Choix techniques

- **Langage** : TypeScript + SDK officiel `@modelcontextprotocol/sdk` (ou Python + `mcp` / FastMCP).
- **Validation** : schémas Zod qui génèrent aussi le JSON Schema exposé aux clients.
- **Idempotence** : chaque `request_to_pay` génère un UUID v4 (`X-Reference-Id`) stocké en base. Un appel rejoué ne déclenche pas de double paiement.
- **Sécurité** :
  - les secrets sont lus depuis des variables d'environnement, jamais exposés au modèle ;
  - un plafond de montant est configurable ;
  - le mode `sandbox` est activé par défaut ;
  - les outils qui modifient l'état sont annotés (`destructiveHint`) pour que le client demande une confirmation.
- **Transports** : `stdio` pour l'usage local, `Streamable HTTP` pour un déploiement distant.

## Installation

```bash
git clone https://github.com/<ton-user>/mcp-mobile-money.git
cd mcp-mobile-money
npm install
cp .env.example .env   # renseigner MOMO_SUBSCRIPTION_KEY, MOMO_API_USER, MOMO_API_KEY
npm run build
```

### Configuration dans Claude Desktop

```json
{
  "mcpServers": {
    "mobile-money": {
      "command": "node",
      "args": ["/chemin/vers/mcp-mobile-money/dist/index.js"],
      "env": { "MOMO_ENV": "sandbox" }
    }
  }
}
```

### Tester avec MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Tests

```bash
npm test          # tests unitaires (client MoMo mocké)
npm run test:e2e  # tests contre la sandbox MoMo
```

## Feuille de route

- [ ] Support FedaPay / Kkiapay
- [ ] Webhooks de callback → notifications MCP
- [ ] Authentification OAuth pour le transport HTTP
- [ ] Publication sur npm et dans le registre MCP

## Avertissement

Projet personnel, non affilié à MTN. Utilisation en production à vos risques. Testez d'abord en sandbox.

## Licence

MIT
