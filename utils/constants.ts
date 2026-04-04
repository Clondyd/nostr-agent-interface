// Set a reasonable timeout for queries
export const QUERY_TIMEOUT = 8000;

export const BUILTIN_DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://purplerelay.com",
  "wss://nostr.land"
];

export function parseEnvRelayList(rawValue: string | undefined): string[] | null {
  if (!rawValue || rawValue.trim() === "") {
    return null;
  }

  const raw = rawValue.trim();

  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("NOSTR_DEFAULT_RELAYS must be a JSON string array or a comma-separated list");
    }

    const normalized = parsed.map((relay) => relay.trim()).filter(Boolean);
    if (normalized.length === 0) {
      throw new Error("NOSTR_DEFAULT_RELAYS cannot be empty");
    }

    return normalized;
  }

  const normalized = raw.split(",").map((relay) => relay.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("NOSTR_DEFAULT_RELAYS cannot be empty");
  }

  return normalized;
}

// Define default relays. Precedence: NOSTR_DEFAULT_RELAYS env var > built-in defaults.
export const DEFAULT_RELAYS = parseEnvRelayList(process.env.NOSTR_DEFAULT_RELAYS) ?? BUILTIN_DEFAULT_RELAYS;

// Add more popular relays that we can try if the default ones fail
export const FALLBACK_RELAYS = [
  "wss://nostr.mom",
  "wss://nostr.noones.com",
  "wss://nostr-pub.wellorder.net",
  "wss://nostr.bitcoiner.social",
  "wss://at.nostrworks.com",
  "wss://lightningrelay.com",
];

// Define event kinds
export const KINDS = {
  // NIP-01 / common kinds
  METADATA: 0,
  TEXT: 1,
  CONTACT_LIST: 3,
  DIRECT_MESSAGE: 4,
  DELETE: 5,
  REPOST: 6,
  REACTION: 7,
  RELAY_LIST: 10002, // NIP-65
  AUTH: 22242, // NIP-42
  BLOSSOM_AUTH: 24242, // BUD-01 auth event
  BLOSSOM_SERVER_LIST: 10063, // Blossom server-list events (BUD-03)
  ZAP_REQUEST: 9734,
  ZAP_RECEIPT: 9735,

  // Back-compat aliases (older naming used in parts of this repo)
  Metadata: 0,
  Text: 1,
  ContactList: 3,
  DirectMessage: 4,
  Delete: 5,
  Repost: 6,
  Reaction: 7,
  RelayList: 10002,
  Auth: 22242,
  BlossomAuth: 24242,
  BlossomServerList: 10063,
  ZapRequest: 9734,
  ZapReceipt: 9735,
} as const;

export type KindName = keyof typeof KINDS;
export type KindValue = (typeof KINDS)[KindName];
export type Kind = KindValue | (number & {});
