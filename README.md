# Canton Alert Bot

Telegram bot for monitoring Canton Network validators across MainNet, TestNet and DevNet.

**[@canton_monitoring_bot](https://t.me/canton_monitoring_bot)**

## Demo

<p align="center">
  <img src="images/demo.png" width="340" alt="Bot start screen" />
  <img src="images/demo2.png" width="340" alt="Track validator" />
</p>

## Features

- Track validators by name or partial party_id
- Persistent reply keyboard — buttons always visible
- Alerts: offline, back online, outdated version
- Uptime 7d shown in validator status
- Fallback data sources: our indexer → Lighthouse
- Per-network support: mainnet / testnet / devnet

## Usage

Use the buttons or type commands directly:

| Button / Command | Description |
|------------------|-------------|
| 🟢 Status / `/status <name> [network]` | Current validator status + uptime |
| ➕ Subscribe / `/track <name> [network]` | Subscribe to alerts |
| 🗑 Unsubscribe / `/untrack <name> [network]` | Unsubscribe |
| 📋 My List / `/list` | All your subscriptions |
| 📊 Network Stats / `/network [network]` | Network stats |

Default network: **mainnet**

## Alerts

| Trigger | Message |
|---------|---------|
| Validator inactive > 25 min | 🔴 Validator offline |
| Validator recovered | 🟢 Validator back online |
| Version behind network | ⚠️ Outdated version |

> Detection delay is ~25 min — Canton round = 10 min, status updates once per round.

## Data Sources

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
# Edit .env — set BOT_TOKEN and optionally ADMIN_CHAT_ID

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
| `ADMIN_CHAT_ID` | — | Your Telegram chat ID for admin alerts and `/admin` command |
| `DB_PATH` | — | SQLite database path (default: `./data/bot.db`) |

## Architecture

```
Telegram ←→ grammy bot (conversations plugin)
              ↓
          monitor.ts (polling every 5 min)
              ↓
          fetchWithFallback()
              ↓
     [our indexer] → [lighthouse direct]
              ↓
          SQLite (subscriptions + validator state + alert log)
```

## Repository

Part of the [Canton Network](https://canton.network) ecosystem toolset.