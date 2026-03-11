import type { Bot } from "grammy";
import {
  fetchWithFallback,
  NETWORKS,
  type Network,
  type Validator,
  type ValidatorsResponse,
  type NetworkStats,
  NETWORK_CONFIG,
} from "./networks.js";

interface NodeStatus {
  enabled: boolean;
  lag_seconds: number | null;
  last_ingested_at: string | null;
  is_healthy: boolean | null;
  validator_name: string | null;
  validator_party: string | null;
}
import {
  getTrackedValidators,
  getSubscribersForValidator,
  getValidatorState,
  upsertValidatorState,
  logAlert,
  getLastAlertType,
  getAllOfflineValidatorStates,
  wasOfflineAlertSent,
} from "./db.js";

const ADMIN_CHAT_ID = process.env["ADMIN_CHAT_ID"] ? Number(process.env["ADMIN_CHAT_ID"]) : null;

const NODE_POLL_INTERVAL_MS = 60 * 1000;
const NODE_LAG_WARN_SEC = 600;
const NODE_LAG_OFFLINE_SEC = 1200;

const nodeAlertState: Partial<Record<Network, "warn" | "offline" | "ok">> = {};

async function notifyAdmin(bot: Bot, msg: string): Promise<void> {
  if (!ADMIN_CHAT_ID) return;
  await bot.api.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown" }).catch(() => {});
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

async function fetchNodeStatus(network: Network): Promise<NodeStatus | null> {
  const url = NETWORK_CONFIG[network].nodeStatusUrl;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as NodeStatus;
  } catch {
    return null;
  }
}

async function pollNodeStatus(bot: Bot, network: Network): Promise<void> {
  const cfg = NETWORK_CONFIG[network];
  const status = await fetchNodeStatus(network);
  if (!status || !status.enabled || status.lag_seconds === null) {
    console.log(`[node-monitor] ${network}: no data (enabled=${status?.enabled ?? false})`);
    return;
  }

  const lag = status.lag_seconds;
  console.log(`[node-monitor] ${network}: lag=${lag}s, node=${status.validator_name ?? "unknown"}`);
  const prev = nodeAlertState[network] ?? "ok";
  const subscribers = getTrackedValidators()
    .filter((t) => t.network === network)
    .flatMap((t) => getSubscribersForValidator(t.party_id, network));
  const uniqueSubs = [...new Set(subscribers)];
  if (uniqueSubs.length === 0) return;

  const nodeName = status.validator_name ?? status.validator_party?.split("::")[0] ?? cfg.label;

  if (lag >= NODE_LAG_OFFLINE_SEC && prev !== "offline") {
    nodeAlertState[network] = "offline";
    const mins = Math.floor(lag / 60);
    const msg =
      `🔴 *[${cfg.label}] Validator node offline*\n` +
      `*${nodeName}*\n` +
      `Node not processing ledger for *${mins} min*\n` +
      `Last activity: ${status.last_ingested_at ?? "unknown"}`;
    for (const chat_id of uniqueSubs) {
      await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch(() => {});
    }
    console.log(`[node-monitor] ${network}: OFFLINE alert sent (lag=${lag}s)`);
  } else if (lag >= NODE_LAG_WARN_SEC && lag < NODE_LAG_OFFLINE_SEC && prev === "ok") {
    nodeAlertState[network] = "warn";
    const mins = Math.floor(lag / 60);
    const msg =
      `⚠️ *[${cfg.label}] Validator node slow*\n` +
      `*${nodeName}*\n` +
      `Node not processing ledger for *${mins} min*`;
    for (const chat_id of uniqueSubs) {
      await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch(() => {});
    }
    console.log(`[node-monitor] ${network}: WARN alert sent (lag=${lag}s)`);
  } else if (lag < NODE_LAG_WARN_SEC && (prev === "offline" || prev === "warn")) {
    nodeAlertState[network] = "ok";
    const msg =
      `🟢 *[${cfg.label}] Validator node recovered*\n` + `*${nodeName}*\n` + `Lag: *${lag}s*`;
    for (const chat_id of uniqueSubs) {
      await bot.api.sendMessage(chat_id, msg, { parse_mode: "Markdown" }).catch(() => {});
    }
    console.log(`[node-monitor] ${network}: RECOVERED (lag=${lag}s)`);
  }
}
const POLL_NETWORK_TIMEOUT_MS = 60 * 1000;
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;

const pendingOffline = new Map<string, number>();

function restorePendingOffline(): void {
  const offlineStates = getAllOfflineValidatorStates();
  let restored = 0;
  for (const { party_id, network } of offlineStates) {
    if (wasOfflineAlertSent(party_id, network)) continue;
    const key = `${network}:${party_id}`;
    pendingOffline.set(key, 1);
    restored++;
  }
  if (offlineStates.length > 0) {
    console.log(
      `[monitor] restored ${restored}/${offlineStates.length} pending offline from state (skipped already alerted)`,
    );
  }
}

const dominantVersionCache: Partial<Record<Network, string>> = {};

function formatLastSeen(last_seen_at: string | null): string {
  if (!last_seen_at) return "unknown";
  const diff = Date.now() - new Date(last_seen_at).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getDominantVersion(validators: Validator[]): string | null {
  const counts: Record<string, number> = {};
  for (const v of validators) {
    if (v.version) counts[v.version] = (counts[v.version] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

/** Canonical ID: use party_id if present, otherwise id */
function canonicalId(v: Validator): string {
  return v.party_id ?? v.id;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function fetchValidatorById(id: string, network: Network): Promise<Validator | null> {
  const result = await fetchWithFallback<Validator>(
    `/api/validators/${encodeURIComponent(id)}`,
    network,
  );
  return result?.data ?? null;
}

async function fetchNetworkVersion(network: Network): Promise<string | null> {
  const result = await fetchWithFallback<{ version?: string }>("/api/stats", network);
  return result?.data.version ?? null;
}

async function pollNetwork(bot: Bot, network: Network): Promise<void> {
  const cfg = NETWORK_CONFIG[network];
  console.log(`[monitor] polling ${network}...`);

  const tracked = getTrackedValidators().filter((t) => t.network === network);
  if (tracked.length === 0) {
    console.log(`[monitor] ${network}: no tracked validators`);
    return;
  }

  const networkVersion = await fetchNetworkVersion(network);
  if (networkVersion) {
    dominantVersionCache[network] = networkVersion;
    console.log(`[monitor] ${network}: network version = ${networkVersion}`);
  }

  let alertsSent = 0;

  for (const { party_id } of tracked) {
    const v = await fetchValidatorById(party_id, network);

    if (!v) {
      console.log(`[monitor] ${network}: validator not found: ${party_id.slice(0, 40)}...`);
      continue;
    }

    const prevState = getValidatorState(party_id, network);
    const isActive = v.is_active ?? false;
    const lastSeenAt = v.last_seen_at ?? null;

    const lastSeenMs = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : null;
    const stale = lastSeenMs !== null && lastSeenMs > OFFLINE_THRESHOLD_MS;
    const effectivelyActive = isActive && !stale;

    upsertValidatorState(party_id, network, effectivelyActive, v.version ?? null, lastSeenAt);

    const subscribers = getSubscribersForValidator(party_id, network);
    if (subscribers.length === 0) continue;

    const label = cfg.label;
    const name =
      v.name ?? v.id?.split("::")[0] ?? party_id.split("::")[0] ?? party_id.slice(0, 20) + "…";
    const pendingKey = `${network}:${party_id}`;

    // ── Offline alert with 2-poll cooldown ──
    const wentOffline = prevState && prevState.is_active === 1 && !effectivelyActive;
    const firstSeenOffline = !prevState && !effectivelyActive;
    const stillOffline =
      prevState &&
      prevState.is_active === 0 &&
      !effectivelyActive &&
      pendingOffline.has(pendingKey);

    if (wentOffline || firstSeenOffline || stillOffline) {
      const count = (pendingOffline.get(pendingKey) ?? 0) + 1;
      pendingOffline.set(pendingKey, count);
      console.log(`[monitor] ${name} offline on ${network}, pending count: ${count}`);

      if (count >= 2) {
        pendingOffline.delete(pendingKey);
        const reason = !isActive
          ? "is_active = false"
          : stale
            ? `not seen for ${formatLastSeen(lastSeenAt)}`
            : "offline";
        const msg =
          `🔴 *[${label}] Validator offline*\n` +
          `*${name}*\n` +
          `Reason: ${reason}\n` +
          `Party: ${party_id}`;
        console.log(`[monitor] ALERT offline: ${name} on ${network}`);
        for (const chat_id of subscribers) {
          await bot.api.sendMessage(chat_id, msg).catch((err) => {
            console.error(`[monitor] failed to send offline alert to ${chat_id}:`, err);
          });
          logAlert(chat_id, party_id, network, "offline");
          alertsSent++;
        }
      }
    } else {
      pendingOffline.delete(pendingKey);
    }

    // ── Back online alert: transition 0→1, only if offline was actually sent ──
    if (prevState && prevState.is_active === 0 && effectivelyActive) {
      const msg = `🟢 *[${label}] Validator back online*\n` + `*${name}*\n` + `Party: ${party_id}`;
      console.log(`[monitor] ALERT online: ${name} on ${network}`);
      for (const chat_id of subscribers) {
        const lastAlert = getLastAlertType(chat_id, party_id, network);
        if (lastAlert !== "offline") {
          console.log(
            `[monitor] skip online alert for ${name} (${chat_id}): last alert was ${lastAlert ?? "none"}`,
          );
          continue;
        }
        await bot.api.sendMessage(chat_id, msg).catch((err) => {
          console.error(`[monitor] failed to send online alert to ${chat_id}:`, err);
        });
        logAlert(chat_id, party_id, network, "online");
        alertsSent++;
      }
    }

    // ── Version alert ──
    const dom = dominantVersionCache[network];
    if (dom && v.version && v.version !== dom) {
      const prevVersion = prevState?.version;
      if (prevVersion === v.version) continue;
      const msg =
        `⚠️ *[${label}] Outdated version*\n` +
        `*${name}*\n` +
        `Version: ${v.version} (network: ${dom})\n` +
        `Party: ${party_id}`;
      console.log(`[monitor] ALERT version: ${name} on ${network}: ${v.version} vs ${dom}`);
      for (const chat_id of subscribers) {
        await bot.api.sendMessage(chat_id, msg).catch((err) => {
          console.error(`[monitor] failed to send version alert to ${chat_id}:`, err);
        });
        logAlert(chat_id, party_id, network, "version");
        alertsSent++;
      }
    }
  }

  console.log(`[monitor] ${network} done: ${tracked.length} tracked, ${alertsSent} alerts sent`);
}

export async function getValidatorInfo(query: string, network: Network): Promise<Validator | null> {
  const results = await findAllValidators(query, network);
  return results[0] ?? null;
}

export async function findAllValidators(query: string, network: Network): Promise<Validator[]> {
  const encoded = encodeURIComponent(query);
  const result = await fetchWithFallback<ValidatorsResponse>(
    `/api/validators?page_size=100&search=${encoded}`,
    network,
  );
  if (!result) return [];
  const validators = result.data.data ?? result.data.validators ?? [];
  const q = query.toLowerCase();

  const exact = validators.filter((v) => v.party_id === query || v.id === query);
  if (exact.length > 0) return exact;

  const byName = validators.filter((v) => v.name?.toLowerCase() === q);
  if (byName.length > 0) return byName;

  const byNamePartial = validators.filter((v) => v.name?.toLowerCase().includes(q));
  if (byNamePartial.length > 0) return byNamePartial;

  return validators.filter((v) => v.id.toLowerCase().startsWith(q));
}

export async function getNetworkStats(network: Network): Promise<{
  stats: NetworkStats | null;
  source: string;
} | null> {
  const result = await fetchWithFallback<NetworkStats>("/api/stats", network);
  if (!result) return null;
  return { stats: result.data, source: result.source };
}

export const lastPollOk: Partial<Record<Network, Date>> = {};

export function startMonitor(bot: Bot): void {
  console.log("[monitor] starting polling for networks:", NETWORKS.join(", "));
  restorePendingOffline();
  console.log(
    `[monitor] poll interval: ${POLL_INTERVAL_MS / 1000}s, offline threshold: ${OFFLINE_THRESHOLD_MS / 1000}s, poll timeout: ${POLL_NETWORK_TIMEOUT_MS / 1000}s`,
  );

  const poll = async () => {
    console.log(`[monitor] === poll cycle start ===`);
    for (const network of NETWORKS) {
      try {
        await withTimeout(
          pollNetwork(bot, network),
          POLL_NETWORK_TIMEOUT_MS,
          `pollNetwork(${network})`,
        );
        lastPollOk[network] = new Date();
      } catch (err) {
        console.error(`[monitor] error polling ${network}:`, err);
        const msg =
          `⚠️ *[Monitor] Poll error — ${network}*\n` +
          `\`${err instanceof Error ? err.message : String(err)}\``;
        await notifyAdmin(bot, msg);
      }
    }
    console.log(`[monitor] === poll cycle end ===`);
  };

  setTimeout(() => {
    void poll();
    setInterval(() => void poll(), POLL_INTERVAL_MS);
  }, 10_000);

  const pollNodes = async () => {
    for (const network of NETWORKS) {
      if (!NETWORK_CONFIG[network].nodeStatusUrl) continue;
      try {
        await pollNodeStatus(bot, network);
      } catch (err) {
        console.error(`[node-monitor] error polling ${network}:`, err);
      }
    }
  };

  setTimeout(() => {
    void pollNodes();
    setInterval(() => void pollNodes(), NODE_POLL_INTERVAL_MS);
  }, 15_000);
}
