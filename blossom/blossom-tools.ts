import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { schnorr } from "@noble/curves/secp256k1";
import { createEvent, getEventHash, signEvent } from "snstr";

import { publishNostrEvent, queryEvents, signNostrEvent } from "../event/event-tools.js";
import { DEFAULT_RELAYS, KINDS, QUERY_TIMEOUT } from "../utils/constants.js";
import { NostrEvent, normalizePrivateKey, npubToHex } from "../utils/index.js";

const BLOSSOM_SERVER_CACHE_TTL_MS = 60_000;
const DEFAULT_BLOSSOM_LIST_LIMIT = 10;
const BLOSSOM_FETCH_TIMEOUT_MS = QUERY_TIMEOUT;
const BLOSSOM_TRANSFER_TIMEOUT_MS = 30_000;
const BLOSSOM_LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOW_INSECURE_BLOSSOM_HTTP = /^(1|true|yes)$/i.test(process.env.ALLOW_INSECURE_BLOSSOM_HTTP ?? "");

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/, "Expected a 64-character SHA-256 hex string");
const httpUrlSchema = z.string().url();

const blossomServerCache = new Map<string, { servers: string[]; expiresAt: number }>();

type BlossomAuthType = "list" | "upload" | "delete";

type BlossomBlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded?: number;
  created?: number;
  [key: string]: unknown;
};

type BlossomDownloadResult = {
  success: boolean;
  message: string;
  blob?: {
    sha256: string;
    url: string;
    size: number;
    type: string;
    status: number;
  };
  outputPath?: string;
  contentBase64?: string;
};

function pubkeyFromPrivateKey(privateKeyHex: string): string {
  return Buffer.from(schnorr.getPublicKey(privateKeyHex)).toString("hex");
}

function normalizeHttpUrl(url: string): string {
  const parsed = new URL(url.trim());
  const isHttps = parsed.protocol === "https:";
  const isAllowedHttp = parsed.protocol === "http:" && (BLOSSOM_LOCAL_HTTP_HOSTS.has(parsed.hostname) || ALLOW_INSECURE_BLOSSOM_HTTP);
  if (!isHttps && !isAllowedHttp) {
    throw new Error(
      `Invalid Blossom server URL: ${url} (expected https://, or http:// only for localhost/loopback hosts or when ALLOW_INSECURE_BLOSSOM_HTTP is enabled)`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeSha256(sha256: string): string {
  const parsed = sha256Schema.safeParse(String(sha256 ?? "").trim());
  if (!parsed.success) {
    throw new Error("Invalid sha256 format. Expected a 64-character hex string.");
  }
  return parsed.data.toLowerCase();
}

function detectContentTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function decodeBase64(content: string): Buffer {
  const normalized = content.trim().replace(/\s+/g, "");
  if (!normalized) {
    throw new Error("content must be a non-empty base64 string");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error("content must be valid base64");
  }
  return Buffer.from(normalized, "base64");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function describeFetchTarget(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = BLOSSOM_FETCH_TIMEOUT_MS): Promise<Response> {
  const request = init ?? {};
  const controller = new AbortController();
  const upstreamSignal = request.signal;
  let didTimeout = false;
  const onAbort = () => controller.abort(upstreamSignal?.reason);

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...request, signal: controller.signal });
  } catch (error) {
    if (didTimeout || (isAbortError(error) && !upstreamSignal?.aborted)) {
      throw new Error(`Request to ${describeFetchTarget(input)} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener("abort", onAbort);
    }
  }
}

function formatAuthContent(type: BlossomAuthType): string {
  if (type === "list") return "List Blobs";
  if (type === "upload") return "Upload Blob";
  return "Delete Blob";
}

export async function createBlossomAuthEvent(params: {
  privateKey: string;
  type: BlossomAuthType;
  sha256?: string;
  createdAt?: number;
  expiration?: number;
}): Promise<NostrEvent> {
  const privateKeyHex = normalizePrivateKey(params.privateKey);
  const pubkey = pubkeyFromPrivateKey(privateKeyHex);
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  const expiration = params.expiration ?? createdAt + 60;
  const tags: string[][] = [
    ["t", params.type],
    ["expiration", String(expiration)],
  ];

  if (params.sha256) {
    tags.push(["x", normalizeSha256(params.sha256)]);
  }

  const unsigned = createEvent(
    {
      kind: KINDS.BLOSSOM_AUTH,
      content: formatAuthContent(params.type),
      created_at: createdAt,
      tags,
    },
    pubkey,
  ) as any;

  const id = await getEventHash(unsigned);
  const sig = await signEvent(id, privateKeyHex);
  return { ...(unsigned as any), id, sig } as NostrEvent;
}

export async function createBlossomAuthorizationHeader(params: {
  privateKey: string;
  type: BlossomAuthType;
  sha256?: string;
  createdAt?: number;
  expiration?: number;
}): Promise<string> {
  const event = await createBlossomAuthEvent(params);
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

export function parseBlossomServerListFromEvent(evt: NostrEvent): string[] {
  const seen = new Set<string>();
  const servers: string[] = [];

  for (const tag of evt.tags ?? []) {
    if (!Array.isArray(tag) || tag[0] !== "server" || typeof tag[1] !== "string") continue;
    try {
      const normalized = normalizeHttpUrl(tag[1]);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      servers.push(normalized);
    } catch {
      // Ignore invalid URLs stored on relays.
    }
  }

  return servers;
}

async function getLatestBlossomServerListEvent(params: {
  relays: string[];
  authorHex: string;
  authPrivateKey?: string;
}): Promise<{ success: boolean; event: NostrEvent | null; message?: string }> {
  const res = await queryEvents({
    relays: params.relays,
    authPrivateKey: params.authPrivateKey,
    kinds: [KINDS.BLOSSOM_SERVER_LIST],
    authors: [params.authorHex],
    limit: 20,
  });

  if (!res.success) {
    return { success: false, event: null, message: res.message };
  }

  const events = (res.events ?? []).slice();
  events.sort((a, b) => {
    if (b.created_at !== a.created_at) return b.created_at - a.created_at;
    return String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });

  return { success: true, event: events[0] ?? null };
}

function serverCacheKey(pubkey: string, relays: string[]): string {
  return `${pubkey.toLowerCase()}::${relays.join(",")}`;
}

function getCachedBlossomServers(pubkey: string, relays: string[]): string[] | null {
  const key = serverCacheKey(pubkey, relays);
  const cached = blossomServerCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    blossomServerCache.delete(key);
    return null;
  }
  return cached.servers.slice();
}

function setCachedBlossomServers(pubkey: string, relays: string[], servers: string[]): void {
  blossomServerCache.set(serverCacheKey(pubkey, relays), {
    servers: servers.slice(),
    expiresAt: Date.now() + BLOSSOM_SERVER_CACHE_TTL_MS,
  });
}

function normalizePubkeyInput(pubkey: string): string | null {
  return npubToHex(pubkey);
}

async function resolveBlossomServerUrl(params: {
  serverUrl?: string;
  privateKey?: string;
  relays?: string[];
}): Promise<{ success: boolean; message?: string; serverUrl?: string }> {
  if (params.serverUrl) {
    try {
      return { success: true, serverUrl: normalizeHttpUrl(params.serverUrl) };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Invalid Blossom server URL." };
    }
  }

  if (!params.privateKey) {
    return { success: false, message: "serverUrl is required when privateKey is not provided." };
  }

  const servers = await getBlossomServers({ privateKey: params.privateKey, relays: params.relays });
  if (!servers.success) {
    return { success: false, message: servers.message };
  }
  if (!servers.servers?.length) {
    return { success: false, message: "No Blossom servers configured for this account." };
  }
  return { success: true, serverUrl: servers.servers[0] };
}

function normalizeBlobDescriptor(blob: Record<string, unknown>, serverUrl: string): BlossomBlobDescriptor {
  const sha256 = normalizeSha256(String(blob.sha256 ?? blob.sha256Hex ?? blob.x ?? ""));
  const normalizedServer = normalizeHttpUrl(serverUrl);
  const url = typeof blob.url === "string" && blob.url.trim()
    ? String(blob.url)
    : `${normalizedServer}/${sha256}`;
  const sizeRaw = blob.size ?? blob.length ?? 0;
  const size = typeof sizeRaw === "number" ? sizeRaw : Number(sizeRaw ?? 0);
  const type = typeof blob.type === "string" && blob.type.trim()
    ? blob.type
    : typeof blob.contentType === "string" && blob.contentType.trim()
      ? blob.contentType
      : "application/octet-stream";

  return {
    ...blob,
    url,
    sha256,
    size: Number.isFinite(size) ? size : 0,
    type,
  } as BlossomBlobDescriptor;
}

async function parseBlobResponse(response: Response, serverUrl: string): Promise<BlossomBlobDescriptor> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Server returned invalid JSON: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Server returned an unexpected blob payload.");
  }

  return normalizeBlobDescriptor(payload as Record<string, unknown>, serverUrl);
}

async function uploadBytes(params: {
  serverUrl: string;
  privateKey: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<BlossomBlobDescriptor> {
  const serverUrl = normalizeHttpUrl(params.serverUrl);
  const bytes = params.bytes instanceof Uint8Array ? params.bytes : new Uint8Array(params.bytes);
  const contentType = params.contentType?.trim() || "application/octet-stream";
  const sha256 = sha256Hex(bytes);
  const total = bytes.byteLength;
  const uploadUrl = `${serverUrl}/upload`;
  const authorization = await createBlossomAuthorizationHeader({
    privateKey: params.privateKey,
    type: "upload",
    sha256,
  });

  const preflightResponse = await fetchWithTimeout(uploadUrl, {
    method: "HEAD",
    headers: {
      Authorization: authorization,
      "X-SHA-256": sha256,
      "X-Content-Type": contentType,
      "X-Content-Length": String(total),
    },
  }, BLOSSOM_FETCH_TIMEOUT_MS);

  if (!preflightResponse.ok && preflightResponse.status !== 404) {
    const reason = preflightResponse.headers.get("X-Reason")?.trim();
    const body = (await preflightResponse.text().catch(() => "")).trim();
    throw new Error(reason || body || `Upload rejected (${preflightResponse.status}).`);
  }

  const response = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "Content-Length": String(total),
    },
    body: Buffer.from(bytes),
  } as any, BLOSSOM_TRANSFER_TIMEOUT_MS);

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).trim();
    throw new Error(body || `Upload failed (${response.status}).`);
  }

  return parseBlobResponse(response, serverUrl);
}

export const getBlossomServersToolConfig = {
  pubkey: z.string().optional().describe("Public key to fetch Blossom servers for (hex format or npub format). Defaults to the pubkey derived from privateKey."),
  privateKey: z.string().optional().describe("Optional private key (hex or nsec) to derive the pubkey for self lookups and to AUTH to relays if needed"),
  relays: z.array(z.string()).optional().describe("Optional list of relays to query for the Blossom server list"),
  authPrivateKey: z.string().optional().describe("Optional private key (hex or nsec) used only for NIP-42 AUTH if relays require it"),
};

export async function getBlossomServers(params: {
  pubkey?: string;
  privateKey?: string;
  relays?: string[];
  authPrivateKey?: string;
}): Promise<{ success: boolean; message: string; pubkey?: string; event?: NostrEvent; servers?: string[] }> {
  const relays = params.relays?.length ? params.relays : DEFAULT_RELAYS;

  let authorHex: string | null = null;
  let authPrivateKey = params.authPrivateKey;

  if (params.pubkey) {
    authorHex = normalizePubkeyInput(params.pubkey);
    if (!authorHex) {
      return { success: false, message: "Invalid public key format. Please provide a valid hex pubkey or npub." };
    }
  }

  if (!authorHex && params.privateKey) {
    try {
      const privateKeyHex = normalizePrivateKey(params.privateKey);
      authorHex = pubkeyFromPrivateKey(privateKeyHex);
      authPrivateKey = authPrivateKey ?? params.privateKey;
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Invalid private key." };
    }
  }

  if (!authorHex) {
    return { success: false, message: "Provide either pubkey or privateKey." };
  }

  const cached = getCachedBlossomServers(authorHex, relays);
  if (cached) {
    return {
      success: true,
      message: `Found ${cached.length} Blossom server${cached.length === 1 ? "" : "s"}.`,
      pubkey: authorHex,
      servers: cached,
    };
  }

  const latest = await getLatestBlossomServerListEvent({
    relays,
    authorHex,
    authPrivateKey,
  });

  if (!latest.success) {
    return { success: false, message: latest.message ?? "Failed to query Blossom server list." };
  }

  if (!latest.event) {
    setCachedBlossomServers(authorHex, relays, []);
    return { success: true, message: "No Blossom server list (kind 10063) found.", pubkey: authorHex, servers: [] };
  }

  const servers = parseBlossomServerListFromEvent(latest.event);
  setCachedBlossomServers(authorHex, relays, servers);

  return {
    success: true,
    message: `Found ${servers.length} Blossom server${servers.length === 1 ? "" : "s"}.`,
    pubkey: authorHex,
    event: latest.event,
    servers,
  };
}

export const setBlossomServersToolConfig = {
  privateKey: z.string().describe("Private key (hex or nsec) for the account publishing the Blossom server list"),
  servers: z.array(httpUrlSchema).describe("Blossom server URLs to publish in kind 10063. First entry becomes preferred."),
  relays: z.array(z.string()).optional().describe("Optional list of relays to publish the server list to"),
};

export async function setBlossomServers(params: {
  privateKey: string;
  servers: string[];
  relays?: string[];
}): Promise<{ success: boolean; message: string; eventId?: string; servers?: string[] }> {
  const relays = params.relays?.length ? params.relays : DEFAULT_RELAYS;
  let privateKeyHex: string;
  let authorHex: string;

  try {
    privateKeyHex = normalizePrivateKey(params.privateKey);
    authorHex = pubkeyFromPrivateKey(privateKeyHex);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Invalid private key." };
  }

  const normalizedServers: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.servers ?? []) {
    try {
      const normalized = normalizeHttpUrl(raw);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      normalizedServers.push(normalized);
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Invalid Blossom server URL." };
    }
  }

  const existing = await getLatestBlossomServerListEvent({
    relays,
    authorHex,
    authPrivateKey: params.privateKey,
  });
  if (!existing.success) {
    return { success: false, message: existing.message ?? "Failed to query existing Blossom server list." };
  }

  const tags = normalizedServers.map((server) => ["server", server]);
  const base = createEvent(
    {
      kind: KINDS.BLOSSOM_SERVER_LIST,
      content: existing.event?.content ?? "",
      tags,
    },
    authorHex,
  ) as any;

  if (existing.event?.created_at && typeof base.created_at === "number" && base.created_at <= existing.event.created_at) {
    base.created_at = existing.event.created_at + 1;
  }

  const unsigned: Omit<NostrEvent, "id" | "sig"> = { ...base, pubkey: authorHex };
  const signedRes = await signNostrEvent({ privateKey: params.privateKey, event: unsigned });
  if (!signedRes.success || !signedRes.signedEvent) {
    return { success: false, message: signedRes.message };
  }

  const published = await publishNostrEvent({
    signedEvent: signedRes.signedEvent,
    relays,
    authPrivateKey: params.privateKey,
  });
  if (!published.success) {
    return { success: false, message: published.message };
  }

  setCachedBlossomServers(authorHex, relays, normalizedServers);

  return {
    success: true,
    message: `Blossom server list published. ${published.message}`,
    eventId: signedRes.signedEvent.id,
    servers: normalizedServers,
  };
}

export const getBlossomUrlToolConfig = {
  sha256: sha256Schema.describe("SHA-256 hash of the blob to resolve"),
  serverUrl: httpUrlSchema.optional().describe("Blossom server URL. If omitted, the preferred server is looked up from kind 10063 using privateKey."),
  privateKey: z.string().optional().describe("Optional private key used to resolve the preferred Blossom server when serverUrl is omitted"),
  relays: z.array(z.string()).optional().describe("Optional list of relays used when resolving the preferred Blossom server"),
};

export async function getBlossomUrl(params: {
  sha256: string;
  serverUrl?: string;
  privateKey?: string;
  relays?: string[];
}): Promise<{ success: boolean; message: string; url?: string; serverUrl?: string; sha256?: string }> {
  let sha256: string;
  try {
    sha256 = normalizeSha256(params.sha256);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Invalid sha256." };
  }

  const resolved = await resolveBlossomServerUrl({
    serverUrl: params.serverUrl,
    privateKey: params.privateKey,
    relays: params.relays,
  });
  if (!resolved.success || !resolved.serverUrl) {
    return { success: false, message: resolved.message ?? "Unable to resolve Blossom server URL." };
  }

  const url = `${resolved.serverUrl}/${sha256}`;
  return {
    success: true,
    message: "Resolved Blossom URL successfully.",
    url,
    serverUrl: resolved.serverUrl,
    sha256,
  };
}

export const uploadBlobToolConfig = {
  privateKey: z.string().describe("Private key (hex or nsec) used to authorize the upload"),
  filePath: z.string().optional().describe("Path to a local file to upload"),
  content: z.string().optional().describe("Base64-encoded file content to upload instead of filePath"),
  contentType: z.string().optional().describe("Optional content type override. Defaults from the file extension or application/octet-stream."),
  serverUrl: httpUrlSchema.optional().describe("Blossom server URL. If omitted, the preferred server is looked up from kind 10063."),
  relays: z.array(z.string()).optional().describe("Optional list of relays used when resolving the preferred Blossom server"),
};

export async function uploadBlob(params: {
  privateKey: string;
  filePath?: string;
  content?: string;
  contentType?: string;
  serverUrl?: string;
  relays?: string[];
}): Promise<{ success: boolean; message: string; blob?: BlossomBlobDescriptor; serverUrl?: string }> {
  if (!params.filePath && !params.content) {
    return { success: false, message: "Provide either filePath or content." };
  }
  if (params.filePath && params.content) {
    return { success: false, message: "Provide either filePath or content, not both." };
  }

  const resolved = await resolveBlossomServerUrl({
    serverUrl: params.serverUrl,
    privateKey: params.privateKey,
    relays: params.relays,
  });
  if (!resolved.success || !resolved.serverUrl) {
    return { success: false, message: resolved.message ?? "Unable to resolve Blossom server URL." };
  }

  try {
    const bytes = params.filePath
      ? new Uint8Array(await readFile(params.filePath))
      : new Uint8Array(decodeBase64(params.content!));
    const contentType = params.contentType?.trim()
      || (params.filePath ? detectContentTypeFromPath(params.filePath) : "application/octet-stream");
    const blob = await uploadBytes({
      serverUrl: resolved.serverUrl,
      privateKey: params.privateKey,
      bytes,
      contentType,
    });

    return {
      success: true,
      message: `Uploaded blob successfully to ${resolved.serverUrl}.`,
      blob,
      serverUrl: resolved.serverUrl,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error uploading blob: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export const downloadBlobToolConfig = {
  sha256: sha256Schema.describe("SHA-256 hash of the blob to download"),
  serverUrl: httpUrlSchema.optional().describe("Blossom server URL. If omitted, the preferred server is looked up from kind 10063 using privateKey."),
  privateKey: z.string().optional().describe("Optional private key used to resolve the preferred Blossom server when serverUrl is omitted"),
  relays: z.array(z.string()).optional().describe("Optional list of relays used when resolving the preferred Blossom server"),
  outputPath: z.string().optional().describe("Optional file path to write the downloaded blob to. If omitted, the tool returns base64 content."),
};

export async function downloadBlob(params: {
  sha256: string;
  serverUrl?: string;
  privateKey?: string;
  relays?: string[];
  outputPath?: string;
}): Promise<BlossomDownloadResult> {
  const urlResult = await getBlossomUrl({
    sha256: params.sha256,
    serverUrl: params.serverUrl,
    privateKey: params.privateKey,
    relays: params.relays,
  });
  if (!urlResult.success || !urlResult.url || !urlResult.serverUrl || !urlResult.sha256) {
    return { success: false, message: urlResult.message };
  }

  try {
    const response = await fetchWithTimeout(urlResult.url, undefined, BLOSSOM_TRANSFER_TIMEOUT_MS);
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      return { success: false, message: body || `Download failed (${response.status}).` };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== urlResult.sha256) {
      throw new Error(`SHA-256 mismatch for ${urlResult.url}: expected ${urlResult.sha256}, got ${actualSha256}.`);
    }
    const type = response.headers.get("content-type")?.trim() || "application/octet-stream";
    const blob = {
      sha256: urlResult.sha256,
      url: urlResult.url,
      size: bytes.byteLength,
      type,
      status: response.status,
    };

    if (params.outputPath) {
      await mkdir(path.dirname(params.outputPath), { recursive: true });
      await writeFile(params.outputPath, bytes);
      return {
        success: true,
        message: `Downloaded blob to ${params.outputPath}.`,
        blob,
        outputPath: params.outputPath,
      };
    }

    return {
      success: true,
      message: "Downloaded blob successfully.",
      blob,
      contentBase64: Buffer.from(bytes).toString("base64"),
    };
  } catch (error) {
    return {
      success: false,
      message: `Error downloading blob: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export const listBlobsToolConfig = {
  privateKey: z.string().optional().describe("Optional private key (hex or nsec) used to authorize the list operation and derive the default pubkey"),
  pubkey: z.string().optional().describe("Pubkey to list blobs for (hex format or npub). Defaults to the pubkey derived from privateKey."),
  serverUrl: httpUrlSchema.optional().describe("Blossom server URL. If omitted, the preferred server is looked up from kind 10063 using privateKey."),
  relays: z.array(z.string()).optional().describe("Optional list of relays used when resolving the preferred Blossom server"),
  limit: z.number().int().min(1).max(200).default(DEFAULT_BLOSSOM_LIST_LIMIT).describe("Maximum number of blobs to fetch"),
};

export async function listBlobs(params: {
  privateKey?: string;
  pubkey?: string;
  serverUrl?: string;
  relays?: string[];
  limit?: number;
}): Promise<{ success: boolean; message: string; serverUrl?: string; pubkey?: string; blobs?: BlossomBlobDescriptor[] }> {
  let pubkey = params.pubkey ? normalizePubkeyInput(params.pubkey) : null;
  if (params.pubkey && !pubkey) {
    return { success: false, message: "Invalid public key format. Please provide a valid hex pubkey or npub." };
  }

  if (!pubkey && params.privateKey) {
    try {
      pubkey = pubkeyFromPrivateKey(normalizePrivateKey(params.privateKey));
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Invalid private key." };
    }
  }

  if (!pubkey) {
    return { success: false, message: "Provide either pubkey or privateKey." };
  }

  const resolved = await resolveBlossomServerUrl({
    serverUrl: params.serverUrl,
    privateKey: params.privateKey,
    relays: params.relays,
  });
  if (!resolved.success || !resolved.serverUrl) {
    return { success: false, message: resolved.message ?? "Unable to resolve Blossom server URL." };
  }

  try {
    const listUrl = new URL(`${resolved.serverUrl}/list/${pubkey}`);
    listUrl.searchParams.set("limit", String(params.limit ?? DEFAULT_BLOSSOM_LIST_LIMIT));

    const headers: Record<string, string> = {};
    if (params.privateKey) {
      headers.Authorization = await createBlossomAuthorizationHeader({
        privateKey: params.privateKey,
        type: "list",
      });
    }

    const response = await fetchWithTimeout(listUrl, { headers }, BLOSSOM_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      return { success: false, message: body || `List failed (${response.status}).` };
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return { success: false, message: "Server returned an unexpected list payload." };
    }

    const blobs = payload
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => normalizeBlobDescriptor(entry, resolved.serverUrl!));

    return {
      success: true,
      message: `Found ${blobs.length} blob${blobs.length === 1 ? "" : "s"}.`,
      serverUrl: resolved.serverUrl,
      pubkey,
      blobs,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error listing blobs: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export const deleteBlobToolConfig = {
  privateKey: z.string().describe("Private key (hex or nsec) used to authorize the delete operation"),
  sha256: sha256Schema.describe("SHA-256 hash of the blob to delete"),
  serverUrl: httpUrlSchema.optional().describe("Blossom server URL. If omitted, the preferred server is looked up from kind 10063."),
  relays: z.array(z.string()).optional().describe("Optional list of relays used when resolving the preferred Blossom server"),
};

export async function deleteBlob(params: {
  privateKey: string;
  sha256: string;
  serverUrl?: string;
  relays?: string[];
}): Promise<{ success: boolean; message: string; sha256?: string; serverUrl?: string }> {
  let sha256: string;
  try {
    sha256 = normalizeSha256(params.sha256);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Invalid sha256." };
  }

  const resolved = await resolveBlossomServerUrl({
    serverUrl: params.serverUrl,
    privateKey: params.privateKey,
    relays: params.relays,
  });
  if (!resolved.success || !resolved.serverUrl) {
    return { success: false, message: resolved.message ?? "Unable to resolve Blossom server URL." };
  }

  try {
    const authorization = await createBlossomAuthorizationHeader({
      privateKey: params.privateKey,
      type: "delete",
      sha256,
    });
    const response = await fetchWithTimeout(`${resolved.serverUrl}/${sha256}`, {
      method: "DELETE",
      headers: {
        Authorization: authorization,
      },
    }, BLOSSOM_FETCH_TIMEOUT_MS);

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      return { success: false, message: body || `Delete failed (${response.status}).` };
    }

    return {
      success: true,
      message: `Deleted blob ${sha256}.`,
      sha256,
      serverUrl: resolved.serverUrl,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error deleting blob: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export const mirrorBlobToolConfig = {
  privateKey: z.string().describe("Private key (hex or nsec) used to authorize the mirror operation"),
  sourceUrl: httpUrlSchema.describe("Source URL to mirror to the Blossom server"),
  serverUrl: httpUrlSchema.optional().describe("Blossom server URL. If omitted, the preferred server is looked up from kind 10063."),
  relays: z.array(z.string()).optional().describe("Optional list of relays used when resolving the preferred Blossom server"),
};

export async function mirrorBlob(params: {
  privateKey: string;
  sourceUrl: string;
  serverUrl?: string;
  relays?: string[];
}): Promise<{ success: boolean; message: string; blob?: BlossomBlobDescriptor; serverUrl?: string; mirroredDirectly?: boolean }> {
  const resolved = await resolveBlossomServerUrl({
    serverUrl: params.serverUrl,
    privateKey: params.privateKey,
    relays: params.relays,
  });
  if (!resolved.success || !resolved.serverUrl) {
    return { success: false, message: resolved.message ?? "Unable to resolve Blossom server URL." };
  }

  try {
    const authorization = await createBlossomAuthorizationHeader({
      privateKey: params.privateKey,
      type: "upload",
    });
    const response = await fetchWithTimeout(`${resolved.serverUrl}/mirror`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: params.sourceUrl }),
    }, BLOSSOM_TRANSFER_TIMEOUT_MS);

    if (response.ok) {
      const blob = await parseBlobResponse(response, resolved.serverUrl);
      return {
        success: true,
        message: `Mirrored blob successfully via ${resolved.serverUrl}/mirror.`,
        blob,
        serverUrl: resolved.serverUrl,
        mirroredDirectly: true,
      };
    }

    const shouldFallback = response.status === 404 || !response.ok;
    if (!shouldFallback) {
      const body = (await response.text().catch(() => "")).trim();
      return { success: false, message: body || `Mirror failed (${response.status}).` };
    }

    const sourceResponse = await fetchWithTimeout(params.sourceUrl, undefined, BLOSSOM_TRANSFER_TIMEOUT_MS);
    if (!sourceResponse.ok) {
      const body = (await sourceResponse.text().catch(() => "")).trim();
      return { success: false, message: body || `Error fetching source (${sourceResponse.status}).` };
    }

    const bytes = new Uint8Array(await sourceResponse.arrayBuffer());
    const contentType = sourceResponse.headers.get("content-type")?.trim() || "application/octet-stream";
    const blob = await uploadBytes({
      serverUrl: resolved.serverUrl,
      privateKey: params.privateKey,
      bytes,
      contentType,
    });

    return {
      success: true,
      message: `Mirror endpoint unavailable; downloaded ${params.sourceUrl} and re-uploaded it successfully.`,
      blob,
      serverUrl: resolved.serverUrl,
      mirroredDirectly: false,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error mirroring blob: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
