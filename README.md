# Canton Alert Bot

Telegram bot for monitoring Canton Network validators across MainNet, TestNet and DevNet.

## Features

- Track validators by party_id per network
- Alerts: offline, back online, outdated version
- Fallback data sources (our indexer → Lighthouse direct)
- Per-network support: mainnet / testnet / devnet

## Commands

| Command | Description |
|---------|-------------|
| `/track <party_id> [network]` | Subscribe to validator alerts |
| `/untrack <party_id> [network]` | Unsubscribe |
| `/status <party_id> [network]` | Current validator status |
| `/list` | All your subscriptions |
| `/network [mainnet\|testnet\|devnet]` | Network stats |

Default network: **mainnet**

## Alerts

| Trigger | Message |
|---------|---------|
| `is_active = false` | 🔴 Validator offline |
| `last_seen_at > 30m` | 🔴 Validator offline (stale) |
| Validator recovered | 🟢 Validator back online |
| Version behind network | ⚠️ Outdated version |

## Data Sources (with fallback)

| Network | Primary | Fallback |
|---------|---------|----------|
| mainnet | mainnet-canton-indexer.web34ever.com | lighthouse.cantonloop.com |
| testnet | testnet-canton-indexer.web34ever.com | lighthouse.testnet.cantonloop.com |
| devnet | devnet-canton-indexer.web34ever.com | lighthouse.devnet.cantonloop.com |

## Setup

### 1. Create Telegram bot

Talk to [@BotFather](https://t.me/BotFather) and get a `BOT_TOKEN`.

### 2. Deploy with Docker

```bash
cp .env.example .env
# Edit .env and set BOT_TOKEN

docker compose up -d --build
```

### 3. Deploy manually

```bash
npm install
npm run build
BOT_TOKEN=your_token node dist/bot.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `DB_PATH` | — | SQLite database path (default: `./data/bot.db`) |

## Architecture

```
Telegram ←→ grammy bot
              ↓
          monitor.ts (polling every 60s)
              ↓
          fetchWithFallback()
              ↓
     [our indexer] → [lighthouse direct]
              ↓
          SQLite (subscriptions + validator state cache)
```

## Repository

Part of the [Canton Network](https://canton.network) ecosystem toolset.