export type Network = "mainnet" | "testnet" | "devnet";

export const NETWORKS: Network[] = ["mainnet", "testnet", "devnet"];

export interface NetworkConfig {
  name: Network;
  label: string;
  endpoints: string[]; // primary first, then fallbacks
  lighthouseUrl: string; // direct lighthouse (always public)
  indexerUrl: string;
}

export const NETWORK_CONFIG: Record<Network, NetworkConfig> = {
  mainnet: {
    name: "mainnet",
    label: "MainNet",
    endpoints: [
      "https://mainnet-canton-indexer.web34ever.com",
      "https://lighthouse.cantonloop.com",
    ],
    lighthouseUrl: "https://lighthouse.cantonloop.com",
    indexerUrl: "https://mainnet-canton-indexer.web34ever.com",
  },
  testnet: {
    name: "testnet",
    label: "TestNet",
    endpoints: [
      "https://testnet-canton-indexer.web34ever.com",
      "https://lighthouse.testnet.cantonloop.com",
    ],
    lighthouseUrl: "https://lighthouse.testnet.cantonloop.com",
    indexerUrl: "https://testnet-canton-indexer.web34ever.com",
  },
  devnet: {
    name: "devnet",
    label: "DevNet",
    endpoints: [
      "https://devnet-canton-indexer.web34ever.com",
      "https://lighthouse.devnet.cantonloop.com",
    ],
    lighthouseUrl: "https://lighthouse.devnet.cantonloop.com",
    indexerUrl: "https://devnet-canton-indexer.web34ever.com",
  },
};

export function parseNetwork(input: string | undefined): Network {
  if (input === "testnet" || input === "devnet") return input;
  return "mainnet";
}

export interface Validator {
  id: string;
  party_id: string | null;
  name: string | null;
  is_active: boolean;
  version: string | null;
  last_seen_at: string | null;
  first_seen_at: string | null;
}

export interface ValidatorsResponse {
  validators?: Validator[];
  data?: Validator[];
  count?: number;
}

export interface NetworkStats {
  version?: string;
  total_validator?: number;
  total_validators?: number; // fallback
  rounds?: Array<{ round: number }> | number;
  total_rounds?: number; // fallback
  cc_price?: string | number;
  total_cc?: string | number;
  total_parties?: number;
  total_transaction?: number;
}

export function extractRoundNumber(stats: NetworkStats): string {
  if (Array.isArray(stats.rounds) && stats.rounds.length > 0) {
    return String(stats.rounds[0]!.round);
  }
  const r = stats.rounds ?? stats.total_rounds;
  return r !== undefined ? String(r) : "unknown";
}

// Fetch with fallback — tries each endpoint in order
export async function fetchWithFallback<T>(
  path: string,
  network: Network,
  timeoutMs = 8000,
): Promise<{ data: T; source: string } | null> {
  const cfg = NETWORK_CONFIG[network];
  for (const base of cfg.endpoints) {
    const url = `${base}${path}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as T;
      return { data, source: base };
    } catch {
      // try next
    }
  }
  return null;
}
