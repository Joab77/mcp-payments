# mcp-mobile-money

> Serveur **MCP (Model Context Protocol)** qui donne à un assistant IA (Claude, ChatGPT, Cursor...) l'accès aux paiements utilisés en Afrique : Mobile Money d'abord, agrégateurs et cartes ensuite. La première version couvre le **Bénin** avec **MTN MoMo** en sandbox. Le reste de l'Afrique de l'Ouest s'ajoute sans toucher au cœur : un pays est un fichier de données, un fournisseur est un adaptateur.

![statut](https://img.shields.io/badge/statut-en%20d%C3%A9veloppement-orange) ![licence](https://img.shields.io/badge/licence-MIT-blue) ![MCP](https://img.shields.io/badge/MCP-2026--07--28-0F3EFA)

---

## Pourquoi ce projet

Un commerçant de Dantokpa encaisse par MTN MoMo, Moov Money ou Celtiis Cash, rarement par carte. La plupart des serveurs MCP de paiement publiés visent les cartes bancaires. Celui-ci part de l'usage réel : un numéro de téléphone, un opérateur, un montant en francs CFA, un client qui valide avec son code sur son téléphone.

Il sert aussi de référence pour un serveur MCP autour d'une API financière : validation stricte, confirmation humaine portée par le serveur, idempotence vraie, journal, données personnelles masquées.

## Périmètre

| | Version 1 | Ensuite |
|---|---|---|
| Pays | Bénin (`BJ`) | Côte d'Ivoire, Togo, Sénégal, Cameroun, Ghana... |
| Fournisseurs | MTN MoMo (Collection) | Moov Money, Celtiis Cash, FedaPay, Kkiapay, Wave, Orange Money |
| Opérations | encaisser, suivre, solde, vérifier un compte | rembourser, payer un tiers (Disbursement), liens de paiement |
| Environnement | sandbox | production, après KYC chez chaque fournisseur |
| Transport | `stdio` | Streamable HTTP avec OAuth |

**Pas de paiement sortant en version 1.** Envoyer de l'argent depuis le compte marchand est l'opération que la prompt injection vise en premier. Elle arrive quand la confirmation humaine, les plafonds et la liste de bénéficiaires autorisés ont fait leurs preuves sur l'encaissement.

## Outils, ressources, prompts

Les noms ne citent aucun fournisseur. L'assistant demande un paiement, le serveur choisit qui l'exécute.

| Outil MCP | Rôle | Annotations |
|---|---|---|
| `request_payment` | Demande un paiement à un numéro : montant, référence marchande, motif, devise si elle diffère de celle du pays | `readOnlyHint: false`, `idempotentHint: true`, `openWorldHint: true` |
| `get_payment_status` | Statut d'un paiement par sa référence : `pending`, `successful`, `failed`, `expired` | `readOnlyHint: true` |
| `get_balance` | Solde du compte marchand, par fournisseur | `readOnlyHint: true` |
| `check_account` | Le numéro est-il un compte actif, et chez quel opérateur | `readOnlyHint: true` |
| `list_payment_methods` | Pays, opérateurs et opérations disponibles avec la configuration en cours | `readOnlyHint: true` |

| Ressource MCP | Rôle |
|---|---|
| `payments://recent` | Les 20 derniers paiements, numéros masqués (`+229 01 97 •• •• 45`) |
| `payments://{reference}` | Le détail d'un paiement et son historique de statuts |

| Prompt MCP | Rôle |
|---|---|
| `relance_paiement` | Message de relance poli pour un paiement resté en attente, en français |

Chaque outil déclare un `outputSchema` : l'assistant reçoit un objet typé, pas une phrase à interpréter.

## Ce qui protège un paiement

1. **Idempotence par référence marchande.** `request_payment` exige une `reference` fournie par l'appelant, par exemple `CMD-2026-0412`. Le serveur la relie une fois pour toutes à l'identifiant du fournisseur (`X-Reference-Id` chez MTN). Rejouer la même référence avec les mêmes paramètres renvoie le paiement existant ; la rejouer avec un autre montant ou un autre numéro est refusé. Un nouvel UUID à chaque appel, lui, ne protège de rien : si l'assistant relance l'outil, le client paie deux fois.
2. **Confirmation portée par le serveur.** Quand le client sait poser une question à l'utilisateur, le serveur répond à `request_payment` par une demande de saisie (`input_required`) qui affiche montant, numéro masqué et motif, et n'exécute qu'après accord. L'état de cette demande voyage signé (HMAC), expire en deux minutes et ne sert qu'une fois. Les annotations comme `destructiveHint` ne sont que des indices pour le client : elles ne remplacent rien.
3. **Repli quand le client ne sait pas confirmer.** En sandbox, le paiement part directement. Hors sandbox, le serveur refuse plutôt que de payer sans accord humain.
4. **Plafonds.** Par paiement, par jour et par numéro, configurables, exprimés dans la devise du pays.
5. **Le payeur valide toujours.** Chez les opérateurs Mobile Money, le client reçoit une demande sur son téléphone et la valide avec son code. Une demande abusive n'enlève pas d'argent, mais elle dérange un client : les plafonds par numéro sont là pour ça.
6. **Aucun secret côté modèle.** Clés et jetons restent dans l'environnement du serveur, jamais dans une réponse ni dans un journal.
7. **Données personnelles masquées.** Les numéros sortent masqués dans les ressources et les journaux. Le journal complet reste en base locale, au sens de la loi béninoise sur les données personnelles (Code du numérique, livre V).

## Architecture

```
Client MCP (Claude Desktop, Cursor...)
        │  JSON-RPC 2.0, spec MCP 2026-07-28 (sans état)
        ▼
┌────────────────────────────────────────────────────────────┐
│ mcp/        outils, ressources, prompts, confirmation      │  traduit MCP en appels métier
├────────────────────────────────────────────────────────────┤
│ app/        PaymentService                                 │  idempotence, politiques, routage
│ policy/     plafonds, confirmation, garde d'environnement  │
│ routing/    pays + opérateur + opération → fournisseur     │
├────────────────────────────────────────────────────────────┤
│ domain/     Money, PhoneNumber, Payment, PaymentStatus     │  aucun import extérieur
│ countries/  BJ.ts : indicatif, format, devise, opérateurs  │  un pays = un fichier de données
├─────────────────────────────┬──────────────────────────────┤
│ providers/                  │ store/                       │
│   PaymentProvider (contrat) │   PaymentRepository          │
│   mtn-momo/   version 1     │   sqlite/   version 1        │
│   fake/       tests, démo   │                              │
│   fedapay/, kkiapay/...     │                              │
└─────────────────────────────┴──────────────────────────────┘
        │  HTTPS
        ▼
API MTN MoMo (sandbox)
```

Les dépendances vont vers le bas, jamais vers le haut. `domain/` ne connaît ni MCP ni MTN.

### Les quatre points d'extension

**Un fournisseur** implémente `PaymentProvider` et déclare ce qu'il sait faire :

```ts
interface PaymentProvider {
  readonly id: ProviderId                     // 'mtn-momo', 'fedapay'...
  readonly capabilities: ProviderCapabilities // pays, opérateurs, devises, opérations
  requestPayment(input: PaymentRequest): Promise<ProviderPayment>
  getPayment(providerRef: string): Promise<ProviderPayment>
  getBalance?(): Promise<Money>
  checkAccount?(phone: PhoneNumber): Promise<AccountCheck>
}
```

Un adaptateur traduit les statuts du fournisseur vers ceux du domaine, et ses erreurs vers les erreurs du domaine. Il passe la **suite de contrat** commune (`tests/contract/`) : les mêmes scénarios rejoués contre chaque fournisseur, le faux compris. Un fournisseur qui la passe est branché.

**Un pays** est un fichier de `countries/` : indicatif, longueur et forme des numéros, devise, opérateurs présents. Pour le Bénin : `+229`, dix chiffres commençant par `01` depuis le 30 novembre 2024, franc CFA (`XOF`, sans décimales), MTN, Moov et Celtiis. Les plages par opérateur y sont datées et sourcées, et ne servent que d'indication : `check_account` tranche.

**Une opération** (remboursement, paiement sortant) est une méthode optionnelle du contrat et une capacité déclarée. Un outil n'apparaît dans `tools/list` que si au moins un fournisseur configuré la porte.

**Un stockage** implémente `PaymentRepository`. SQLite en version 1, Postgres le jour où le serveur tourne à plusieurs instances.

### Choix techniques

- **TypeScript**, Node 20 ou plus, SDK MCP v2 (`@modelcontextprotocol/server`), qui suit la spec 2026-07-28.
- **Zod 4** pour les entrées des outils, la configuration et les réponses des fournisseurs. Les schémas des outils deviennent le JSON Schema exposé.
- **Montants en entiers** dans la plus petite unité de la devise (`XOF` n'a pas de décimales, `EUR` en a deux). Jamais de nombre à virgule pour de l'argent.
- **Devise du pays par défaut.** Sans `currency`, un paiement au Bénin part en `XOF`. Une autre devise est acceptée si un fournisseur configuré la déclare pour ce pays, refusée sinon. Le serveur ne convertit jamais : pas de taux de change sur un paiement. En sandbox, la devise par défaut devient celle que le fournisseur impose (`EUR` chez MTN), et chaque réponse dit la devise réellement employée.
- **Numéros au format E.164** dans le domaine (`+2290197000045`), normalisés à l'entrée depuis les formes courantes (`0197000045`, `229...`, ancien format à huit chiffres).
- **Client MTN** : jeton OAuth2 gardé en cache jusqu'à une minute avant son expiration. Nouvelles tentatives avec attente exponentielle et aléa sur les erreurs 5xx et 429, sauf pour une création de paiement dont on ignore si elle est arrivée : là, on consulte le statut avec la même référence.
- **Journal** sur `stderr` en JSON (`pino`), jamais sur `stdout`, qui porte le protocole en `stdio`.
- **Configuration** validée au démarrage : un serveur mal configuré s'arrête avec un message clair au lieu d'échouer au premier paiement.

## Installation

```bash
git clone https://github.com/<ton-user>/mcp-mobile-money.git
cd mcp-mobile-money
npm install
npm run build
```

### Clés sandbox MTN MoMo

1. Créer un compte sur [momodeveloper.mtn.com](https://momodeveloper.mtn.com) et s'abonner au produit **Collection** : la clé d'abonnement s'affiche dans le profil.
2. Créer l'utilisateur API et sa clé :
   ```bash
   MOMO_SUBSCRIPTION_KEY=... npm run momo:provision
   ```
   Le script appelle `POST /v1_0/apiuser` puis `POST /v1_0/apiuser/{id}/apikey` et affiche les deux valeurs. La clé API ne se relit pas : la noter tout de suite.
3. En sandbox, MTN n'accepte que l'euro (`EUR`) et l'environnement cible `sandbox` : le serveur s'y règle seul. En production au Bénin : `XOF` et `mtnbenin`.

### Configuration dans Claude Desktop

Claude Desktop lance le serveur depuis son propre dossier : un fichier `.env` du projet n'y est pas lu. Les variables passent dans `env`.

```json
{
  "mcpServers": {
    "paiements": {
      "command": "node",
      "args": ["/chemin/vers/mcp-mobile-money/dist/index.js"],
      "env": {
        "PAY_ENV": "sandbox",
        "PAY_COUNTRY": "BJ",
        "PAY_PROVIDERS": "mtn-momo",
        "MOMO_SUBSCRIPTION_KEY": "...",
        "MOMO_API_USER": "...",
        "MOMO_API_KEY": "...",
        "PAY_MAX_AMOUNT": "50000",
        "PAY_STATE_SECRET": "une chaîne aléatoire de 32 octets ou plus"
      }
    }
  }
}
```

Toutes les variables sont décrites dans `.env.example`.

### Essayer sans clé

```bash
PAY_PROVIDERS=fake npx @modelcontextprotocol/inspector node dist/index.js
```

Le fournisseur `fake` rend un paiement réussi, refusé ou en attente selon le dernier chiffre du numéro, sur le modèle des numéros de test de la sandbox MTN.

## Tests

```bash
npm test               # domaine, politiques, service, adaptateurs avec HTTP simulé
npm run test:contract  # suite de contrat contre le fournisseur fake
npm run test:sandbox   # suite de contrat contre la sandbox MTN (clés requises)
```

## Feuille de route

- [ ] Version 1 : Bénin, MTN MoMo Collection, `stdio`, SQLite
- [ ] Kkiapay puis FedaPay : un adaptateur d'agrégateur couvre plusieurs opérateurs d'un coup (MTN et Moov, Celtiis selon l'agrégateur)
- [ ] Callbacks des fournisseurs reçus par un petit serveur HTTP, statuts mis à jour sans attendre une question
- [ ] Streamable HTTP avec OAuth, refus de démarrer sans authentification
- [ ] Côte d'Ivoire et Togo : un fichier pays chacun
- [ ] Paiement sortant, avec liste de bénéficiaires autorisés
- [ ] Publication sur npm et dans le registre MCP

## Avertissement

Projet personnel, sans lien avec MTN, Moov, Celtiis, FedaPay ni Kkiapay. Tout passe d'abord en sandbox ; la production demande un contrat et un KYC chez chaque fournisseur.

## Licence

MIT
