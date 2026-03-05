import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import type { Network } from "./networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env["DB_PATH"] ?? path.join(__dirname, "../../data/bot.db");

const db = new Database(DB_PATH);

db.exec(`DROP TABLE IF EXISTS validator_state;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    party_id    TEXT    NOT NULL,
    network     TEXT    NOT NULL DEFAULT 'mainnet',
    added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (chat_id, party_id, network)
  );

  CREATE TABLE IF NOT EXISTS validator_state (
    party_id    TEXT    NOT NULL,
    network     TEXT    NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    version     TEXT,
    last_seen_at TEXT,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (party_id, network)
  );

  CREATE TABLE IF NOT EXISTS alert_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    party_id    TEXT    NOT NULL,
    network     TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    sent_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface Subscription {
  id: number;
  chat_id: number;
  party_id: string;
  network: Network;
  added_at: string;
}

export interface ValidatorState {
  party_id: string;
  network: Network;
  is_active: number;
  version: string | null;
  last_seen_at: string | null;
  updated_at: string;
}


export function addSubscription(chat_id: number, party_id: string, network: Network): boolean {
  try {
    db.prepare(`INSERT INTO subscriptions (chat_id, party_id, network) VALUES (?, ?, ?)`).run(
      chat_id,
      party_id,
      network,
    );
    return true;
  } catch {
    return false;
  }
}

export function removeSubscription(chat_id: number, party_id: string, network: Network): boolean {
  const result = db
    .prepare(`DELETE FROM subscriptions WHERE chat_id = ? AND party_id = ? AND network = ?`)
    .run(chat_id, party_id, network);
  return result.changes > 0;
}

export function getSubscriptions(chat_id: number): Subscription[] {
  return db
    .prepare(`SELECT * FROM subscriptions WHERE chat_id = ? ORDER BY network, party_id`)
    .all(chat_id) as Subscription[];
}

export function getAllSubscriptions(): Subscription[] {
  return db.prepare(`SELECT * FROM subscriptions`).all() as Subscription[];
}

export function getSubscribersForValidator(party_id: string, network: Network): number[] {
  const rows = db
    .prepare(`SELECT chat_id FROM subscriptions WHERE party_id = ? AND network = ?`)
    .all(party_id, network) as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}

export function getTrackedValidators(): { party_id: string; network: Network }[] {
  return db.prepare(`SELECT DISTINCT party_id, network FROM subscriptions`).all() as {
    party_id: string;
    network: Network;
  }[];
}


export function getValidatorState(party_id: string, network: Network): ValidatorState | null {
  return (
    (db
      .prepare(`SELECT * FROM validator_state WHERE party_id = ? AND network = ?`)
      .get(party_id, network) as ValidatorState | undefined) ?? null
  );
}


export function logAlert(chat_id: number, party_id: string, network: Network, type: string): void {
  db.prepare(`INSERT INTO alert_log (chat_id, party_id, network, type) VALUES (?, ?, ?, ?)`).run(
    chat_id,
    party_id,
    network,
    type,
  );
}

export function getAlertCount24h(): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM alert_log WHERE sent_at >= datetime('now', '-24 hours')`)
    .get() as { cnt: number };
  return row.cnt;
}

export function getUniqueUsersCount(): number {
  const row = db.prepare(`SELECT COUNT(DISTINCT chat_id) as cnt FROM subscriptions`).get() as {
    cnt: number;
  };
  return row.cnt;
}

export function getSubscriptionsCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions`).get() as { cnt: number };
  return row.cnt;
}

export function getSubscriptionsByNetwork(): Record<string, number> {
  const rows = db
    .prepare(`SELECT network, COUNT(*) as cnt FROM subscriptions GROUP BY network`)
    .all() as { network: string; cnt: number }[];
  const result: Record<string, number> = {};
  for (const r of rows) result[r.network] = r.cnt;
  return result;
}

export function upsertValidatorState(
  party_id: string,
  network: Network,
  is_active: boolean,
  version: string | null,
  last_seen_at: string | null,
): void {
  db.prepare(
    `INSERT INTO validator_state (party_id, network, is_active, version, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (party_id, network) DO UPDATE SET
       is_active    = excluded.is_active,
       version      = excluded.version,
       last_seen_at = excluded.last_seen_at,
       updated_at   = datetime('now')`,
  ).run(party_id, network, is_active ? 1 : 0, version, last_seen_at);
}
