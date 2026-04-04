import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1";
import { encodeProfile } from "snstr";
import { describeNetwork } from "./support/network-suite.js";
import { createNote as createUnsignedNote, signNote as signLocalNote } from "../note/note-tools.js";
import {
  createNostrEvent as createGenericEvent,
  publishNostrEvent as publishGenericEvent,
  queryEvents,
  signNostrEvent as signGenericEvent,
} from "../event/event-tools.js";
import { KINDS, QUERY_TIMEOUT } from "../utils/constants.js";
import { NostrRelay } from "../utils/ephemeral-relay.js";
import { CompatibleRelayPool } from "../utils/pool.js";

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<any>;

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: ToolHandler;
};

const connectMock = mock(async (_transport: unknown) => {});
const createdTransports: FakeStdioServerTransport[] = [];

class FakeMcpServer {
  readonly info: Record<string, unknown>;
  readonly tools: RegisteredTool[] = [];
  readonly connect = connectMock;

  constructor(info: Record<string, unknown>) {
    this.info = info;
  }

  tool(name: string, description: string, inputSchema: unknown, handler: ToolHandler): this {
    this.tools.push({ name, description, inputSchema, handler });
    return this;
  }
}

class FakeStdioServerTransport {
  constructor() {
    createdTransports.push(this);
  }
}

mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: FakeMcpServer,
}));

mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: FakeStdioServerTransport,
}));

let createNostrMcpServer: typeof import("../index.js").createNostrMcpServer;
let startMcpStdioServer: typeof import("../index.js").startMcpStdioServer;
let normalizeAnonymousZapErrorMessage: typeof import("../index.js").normalizeAnonymousZapErrorMessage;
let buildSentZapsResponseText: typeof import("../index.js").buildSentZapsResponseText;
let buildAllZapsResponseText: typeof import("../index.js").buildAllZapsResponseText;
let indexModuleLoaded = false;

async function ensureIndexModuleLoaded(): Promise<void> {
  if (indexModuleLoaded) return;

  const hadWebSocket = typeof (globalThis as any).WebSocket !== "undefined";
  if (!hadWebSocket) {
    (globalThis as any).WebSocket = class PlaceholderWebSocket {};
  }

  const mod = await import("../index.js");
  createNostrMcpServer = mod.createNostrMcpServer;
  startMcpStdioServer = mod.startMcpStdioServer;
  normalizeAnonymousZapErrorMessage = mod.normalizeAnonymousZapErrorMessage;
  buildSentZapsResponseText = mod.buildSentZapsResponseText;
  buildAllZapsResponseText = mod.buildAllZapsResponseText;
  indexModuleLoaded = true;

  if (!hadWebSocket) {
    delete (globalThis as any).WebSocket;
  }
}

const VALID_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
const ALT_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000002";
const THIRD_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000003";
const FOURTH_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000004";
const FIFTH_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000005";
const SIXTH_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000006";
const VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1 =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2 = Buffer.from(schnorr.getPublicKey(ALT_PRIVATE_KEY)).toString("hex");
const VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3 = Buffer.from(schnorr.getPublicKey(THIRD_PRIVATE_KEY)).toString("hex");
const VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4 = Buffer.from(schnorr.getPublicKey(FOURTH_PRIVATE_KEY)).toString("hex");
const VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5 = Buffer.from(schnorr.getPublicKey(FIFTH_PRIVATE_KEY)).toString("hex");
const VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_6 = Buffer.from(schnorr.getPublicKey(SIXTH_PRIVATE_KEY)).toString("hex");
const DUMMY_HEX_PUBKEY = "f".repeat(64);
const DUMMY_EVENT_ID = "a".repeat(64);

const EXPECTED_TOOL_NAMES = [
  "analyzeNip19",
  "convertNip19",
  "createKeypair",
  "createNostrEvent",
  "createNote",
  "createProfile",
  "decryptDmNip44",
  "decryptNip04",
  "decryptNip44",
  "deleteBlob",
  "deleteEvent",
  "downloadBlob",
  "encryptNip04",
  "encryptNip44",
  "follow",
  "getAllZaps",
  "getBlossomServers",
  "getBlossomUrl",
  "getContactList",
  "getDmConversationNip04",
  "getDmInboxNip44",
  "getFollowing",
  "getKind1Notes",
  "getLongFormNotes",
  "getProfile",
  "getReceivedZaps",
  "getRelayList",
  "getSentZaps",
  "listBlobs",
  "mirrorBlob",
  "postAnonymousNote",
  "postNote",
  "publishNostrEvent",
  "publishNote",
  "queryEvents",
  "reactToEvent",
  "replyToEvent",
  "repostEvent",
  "sendAnonymousZap",
  "sendDmNip04",
  "sendDmNip44",
  "setBlossomServers",
  "setRelayList",
  "signNostrEvent",
  "signNote",
  "unfollow",
  "updateProfile",
  "uploadBlob",
].sort();

function textFromResult(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function getHandler(server: FakeMcpServer, toolName: string): ToolHandler {
  const found = server.tools.find((t) => t.name === toolName);
  if (!found) throw new Error(`Missing tool: ${toolName}`);
  return found.handler;
}

async function pollForToolText(
  handler: ToolHandler,
  args: Record<string, unknown>,
  isReady: (text: string) => boolean,
  timeoutMs = QUERY_TIMEOUT,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";

  while (Date.now() < deadline) {
    const result = await handler(args, {});
    lastText = textFromResult(result);
    if (isReady(lastText)) return lastText;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return lastText;
}

function buildZapDescription(params: {
  senderPubkey: string;
  recipientPubkey: string;
  amountMsats: number;
  content: string;
}): string {
  return JSON.stringify({
    kind: 9734,
    content: params.content,
    tags: [
      ["p", params.recipientPubkey],
      ["amount", String(params.amountMsats)],
    ],
    pubkey: params.senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    id: `${params.senderPubkey.slice(0, 8)}-${params.recipientPubkey.slice(0, 8)}`,
    sig: "e".repeat(128),
  });
}

describeNetwork("index.ts MCP entrypoint coverage", () => {
  let relay: NostrRelay;
  let relayUrl = "";

  beforeAll(async () => {
    await ensureIndexModuleLoaded();
    relay = new NostrRelay(0);
    await relay.start();
    relayUrl = relay.url;
  });

  afterAll(async () => {
    await relay.close();
  });

  beforeEach(async () => {
    await ensureIndexModuleLoaded();
    connectMock.mockClear();
    createdTransports.length = 0;
  });

  test("registers the complete tool catalog through createNostrMcpServer", () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;

    expect(server.info).toEqual({ name: "nostr", version: "1.0.0" });
    expect(server.tools.length).toBe(EXPECTED_TOOL_NAMES.length);
    expect(server.tools.every((t) => typeof t.handler === "function")).toBe(true);

    const names = server.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  test("exercises deterministic validation/success paths across registered handlers", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;

    const cases: Array<{ toolName: string; args: Record<string, unknown>; expectedText: string }> = [
      { toolName: "getProfile", args: { pubkey: "invalid_pubkey" }, expectedText: "Invalid public key format" },
      { toolName: "getKind1Notes", args: { pubkey: "invalid_pubkey", limit: 1 }, expectedText: "Invalid public key format" },
      { toolName: "getReceivedZaps", args: { pubkey: "invalid_pubkey", limit: 1 }, expectedText: "Invalid public key format" },
      { toolName: "getSentZaps", args: { pubkey: "invalid_pubkey", limit: 1 }, expectedText: "Invalid public key format" },
      { toolName: "getAllZaps", args: { pubkey: "invalid_pubkey", limit: 1 }, expectedText: "Invalid public key format" },
      { toolName: "getLongFormNotes", args: { pubkey: "invalid_pubkey", limit: 1 }, expectedText: "Invalid public key format" },
      { toolName: "queryEvents", args: { authors: ["invalid_author_value"], limit: 1 }, expectedText: "One or more author identifiers are invalid" },
      { toolName: "getContactList", args: { pubkey: "invalid_pubkey" }, expectedText: "Invalid public key format" },
      { toolName: "getFollowing", args: { pubkey: "invalid_pubkey" }, expectedText: "Invalid public key format" },
      { toolName: "getRelayList", args: { pubkey: "invalid_pubkey" }, expectedText: "Invalid public key format" },
      { toolName: "setRelayList", args: { privateKey: VALID_PRIVATE_KEY, relayList: [{ url: "https://bad-relay.example", read: true }] }, expectedText: "Invalid relay URL" },
      { toolName: "follow", args: { privateKey: VALID_PRIVATE_KEY, targetPubkey: "bad_pubkey" }, expectedText: "Invalid target pubkey format" },
      { toolName: "unfollow", args: { privateKey: VALID_PRIVATE_KEY, targetPubkey: "bad_pubkey" }, expectedText: "Invalid target pubkey format" },
      { toolName: "reactToEvent", args: { privateKey: VALID_PRIVATE_KEY, target: "bad_event", reaction: "+" }, expectedText: "Invalid target event id" },
      { toolName: "repostEvent", args: { privateKey: VALID_PRIVATE_KEY, target: "bad_event" }, expectedText: "Invalid target event id" },
      { toolName: "deleteEvent", args: { privateKey: VALID_PRIVATE_KEY, targets: ["bad_event"] }, expectedText: "One or more target ids are invalid" },
      { toolName: "replyToEvent", args: { privateKey: VALID_PRIVATE_KEY, target: "bad_event", content: "hello" }, expectedText: "Invalid target event id" },
      { toolName: "encryptNip04", args: { privateKey: VALID_PRIVATE_KEY, recipientPubkey: "bad_pubkey", plaintext: "hello" }, expectedText: "Invalid recipient pubkey format" },
      { toolName: "decryptNip04", args: { privateKey: VALID_PRIVATE_KEY, senderPubkey: "bad_pubkey", ciphertext: "cipher?iv=iv" }, expectedText: "Invalid sender pubkey format" },
      { toolName: "sendDmNip04", args: { privateKey: VALID_PRIVATE_KEY, recipientPubkey: "bad_pubkey", content: "hello" }, expectedText: "Invalid recipient pubkey format" },
      { toolName: "getDmConversationNip04", args: { privateKey: "bad_private_key", peerPubkey: DUMMY_HEX_PUBKEY }, expectedText: "Invalid private key format." },
      { toolName: "encryptNip44", args: { privateKey: VALID_PRIVATE_KEY, recipientPubkey: "bad_pubkey", plaintext: "hello" }, expectedText: "Invalid recipient pubkey format" },
      { toolName: "decryptNip44", args: { privateKey: VALID_PRIVATE_KEY, senderPubkey: "bad_pubkey", ciphertext: "ciphertext" }, expectedText: "Invalid sender pubkey format" },
      { toolName: "sendDmNip44", args: { privateKey: VALID_PRIVATE_KEY, recipientPubkey: "bad_pubkey", content: "hello" }, expectedText: "Invalid recipient pubkey format" },
      {
        toolName: "decryptDmNip44",
        args: {
          privateKey: "bad_private_key",
          giftWrapEvent: {
            id: DUMMY_EVENT_ID,
            pubkey: DUMMY_HEX_PUBKEY,
            created_at: 1700000000,
            kind: 1059,
            tags: [],
            content: "encrypted",
            sig: "b".repeat(128),
          },
        },
        expectedText: "Gift wrap decryption failed",
      },
      { toolName: "getDmInboxNip44", args: { privateKey: "bad_private_key" }, expectedText: "Invalid private key format." },
      { toolName: "sendAnonymousZap", args: { target: "invalid_target", amountSats: 21, comment: "" }, expectedText: "Failed to prepare anonymous zap: Invalid target." },
      { toolName: "convertNip19", args: { input: "invalid_input", targetType: "npub" }, expectedText: "Conversion failed:" },
      { toolName: "analyzeNip19", args: { input: "not_a_valid_nip19_or_hex" }, expectedText: "Analysis failed:" },
      { toolName: "postAnonymousNote", args: { content: "hello", relays: [] }, expectedText: "Failed to post anonymous note: Failed to publish note to any relay" },
      { toolName: "createKeypair", args: { format: "hex" }, expectedText: "New Nostr keypair generated:" },
      { toolName: "createProfile", args: { privateKey: "bad_private_key", name: "x" }, expectedText: "Failed to create profile: Fatal error:" },
      { toolName: "updateProfile", args: { privateKey: "bad_private_key", name: "x" }, expectedText: "Failed to update profile: Fatal error:" },
      { toolName: "postNote", args: { privateKey: "bad_private_key", content: "hello" }, expectedText: "Failed to post note: Fatal error:" },
      { toolName: "createNote", args: { privateKey: "bad_private_key", content: "hello" }, expectedText: "Failed to create note: Error creating note:" },
      {
        toolName: "signNote",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          noteEvent: {
            kind: 1,
            content: "hello",
            tags: [],
            created_at: 1700000000,
            pubkey: DUMMY_HEX_PUBKEY,
          },
        },
        expectedText: "Failed to sign note: Private key does not match",
      },
      {
        toolName: "publishNote",
        args: {
          signedNote: {
            id: DUMMY_EVENT_ID,
            pubkey: DUMMY_HEX_PUBKEY,
            created_at: 1700000000,
            kind: 1,
            tags: [],
            content: "hello",
            sig: "c".repeat(128),
          },
          relays: [],
        },
        expectedText: "Note published successfully!",
      },
      { toolName: "createNostrEvent", args: { kind: 1, content: "hello" }, expectedText: "You must provide either pubkey" },
      {
        toolName: "signNostrEvent",
        args: {
          privateKey: ALT_PRIVATE_KEY,
          event: {
            pubkey: DUMMY_HEX_PUBKEY,
            created_at: 1700000000,
            kind: 1,
            tags: [],
            content: "hello",
          },
        },
        expectedText: "Private key does not match the public key in the event.",
      },
      {
        toolName: "publishNostrEvent",
        args: {
          signedEvent: {
            id: DUMMY_EVENT_ID,
            pubkey: DUMMY_HEX_PUBKEY,
            created_at: 1700000000,
            kind: 1,
            tags: [],
            content: "hello",
            sig: "d".repeat(128),
          },
          relays: [],
          authPrivateKey: "bad_private_key",
        },
        expectedText: "Invalid private key format",
      },
    ];

    for (const c of cases) {
      const handler = getHandler(server, c.toolName);
      const result = await handler(c.args, {});
      const text = textFromResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(c.expectedText);
    }
  });

  test("covers empty-result branches for query-style wrappers with valid pubkeys", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const validPubkey = DUMMY_HEX_PUBKEY;

    const cases: Array<{ toolName: string; args: Record<string, unknown>; expectedText: string }> = [
      {
        toolName: "getProfile",
        args: { pubkey: validPubkey, relays: [] },
        expectedText: "No profile found for",
      },
      {
        toolName: "getKind1Notes",
        args: { pubkey: validPubkey, relays: [], limit: 1 },
        expectedText: "No notes found for",
      },
      {
        toolName: "getReceivedZaps",
        args: { pubkey: validPubkey, relays: [], limit: 1, validateReceipts: true, debug: true },
        expectedText: "No zaps found for",
      },
      {
        toolName: "getSentZaps",
        args: { pubkey: validPubkey, relays: [], limit: 1, validateReceipts: true, debug: true },
        expectedText: "No zap receipts found to analyze",
      },
      {
        toolName: "getAllZaps",
        args: { pubkey: validPubkey, relays: [], limit: 1, validateReceipts: true, debug: true },
        expectedText: "No zaps found for",
      },
      {
        toolName: "getLongFormNotes",
        args: { pubkey: validPubkey, relays: [], limit: 1 },
        expectedText: "No long-form notes found for",
      },
    ];

    for (const c of cases) {
      const handler = getHandler(server, c.toolName);
      const result = await handler(c.args, {});
      const text = textFromResult(result);
      expect(text).toContain(c.expectedText);
    }
  });

  test("covers wrapper-level catch formatting when relay list formatting throws", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const validPubkey = DUMMY_HEX_PUBKEY;
    const weirdRelays = {
      forEach: (_fn: (value: string) => void) => {},
      join: () => {
        throw new Error("join-boom");
      },
      length: 0,
    } as any;

    const cases: Array<{ toolName: string; expectedText: string }> = [
      { toolName: "getProfile", expectedText: "Error fetching profile" },
      { toolName: "getKind1Notes", expectedText: "Error fetching notes" },
      { toolName: "getReceivedZaps", expectedText: "Error fetching zaps" },
      { toolName: "getSentZaps", expectedText: "Error fetching sent zaps" },
      { toolName: "getAllZaps", expectedText: "Error fetching all zaps" },
      { toolName: "getLongFormNotes", expectedText: "Error fetching long-form notes" },
    ];

    for (const c of cases) {
      const handler = getHandler(server, c.toolName);
      const result = await handler(
        { pubkey: validPubkey, relays: weirdRelays, limit: 1, validateReceipts: true, debug: true },
        {},
      );
      const text = textFromResult(result);
      expect(text).toContain(c.expectedText);
      expect(text).toContain("join-boom");
    }
  });

  test("covers query wrapper success branches with deterministic mocked pool responses", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const getProfileHandler = getHandler(server, "getProfile");
    const getKind1NotesHandler = getHandler(server, "getKind1Notes");
    const getReceivedZapsHandler = getHandler(server, "getReceivedZaps");
    const getSentZapsHandler = getHandler(server, "getSentZaps");
    const getAllZapsHandler = getHandler(server, "getAllZaps");
    const getLongFormNotesHandler = getHandler(server, "getLongFormNotes");

    const now = Math.floor(Date.now() / 1000);
    const profileEvent = {
      id: "1".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      created_at: now,
      kind: KINDS.Metadata,
      tags: [],
      content: JSON.stringify({ name: "Mock User", about: "mock about" }),
      sig: "a".repeat(128),
    };
    const noteOlder = {
      id: "2".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      created_at: now - 10,
      kind: KINDS.Text,
      tags: [],
      content: "older note",
      sig: "b".repeat(128),
    };
    const noteNewer = {
      id: "3".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      created_at: now - 1,
      kind: KINDS.Text,
      tags: [],
      content: "newer note",
      sig: "c".repeat(128),
    };
    const sentZap = {
      id: "4".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
      created_at: now - 2,
      kind: KINDS.ZapReceipt,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            amountMsats: 42000,
            content: "sent zap",
          }),
        ],
      ],
      content: "",
      sig: "d".repeat(128),
    };
    const invalidZap = {
      id: "5".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
      created_at: now - 3,
      kind: KINDS.ZapReceipt,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            amountMsats: 1000,
            content: "invalid missing bolt11",
          }),
        ],
      ],
      content: "",
      sig: "e".repeat(128),
    };
    const sentOnlyZap = {
      id: "8".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
      created_at: now - 1,
      kind: KINDS.ZapReceipt,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            amountMsats: 21000,
            content: "sent-only",
          }),
        ],
      ],
      content: "",
      sig: "1".repeat(128),
    };
    const irrelevantZap = {
      id: "6".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
      created_at: now - 4,
      kind: KINDS.ZapReceipt,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
            amountMsats: 5000,
            content: "irrelevant",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const longForm = {
      id: "7".repeat(64),
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      created_at: now - 5,
      kind: 30023,
      tags: [
        ["title", "Mock Longform"],
        ["image", "https://example.com/mock.png"],
        ["summary", "mock summary"],
        ["published_at", "1700000000"],
        ["d", "mock-article"],
      ],
      content: "long-form content",
      sig: "9".repeat(128),
    };

    const poolProto = CompatibleRelayPool.prototype as any;
    const originalGet = poolProto.get;
    const originalQuerySync = poolProto.querySync;
    const originalClose = poolProto.close;
    let sentQueryCount = 0;

    poolProto.get = async (_relays: string[], filter: any) => {
      if (Array.isArray(filter?.kinds) && filter.kinds.includes(KINDS.Metadata)) {
        return profileEvent;
      }
      return null;
    };
    poolProto.querySync = async (_relays: string[], filter: any) => {
      if (Array.isArray(filter?.kinds) && filter.kinds.includes(KINDS.Text)) {
        return [noteOlder, noteNewer];
      }
      if (Array.isArray(filter?.kinds) && filter.kinds.includes(30023)) {
        return [longForm];
      }
      if (Array.isArray(filter?.kinds) && filter.kinds.includes(KINDS.ZapReceipt)) {
        if (filter?.["#p"]) {
          return [sentZap, invalidZap, irrelevantZap];
        }
        if (filter?.["#P"]) {
          sentQueryCount += 1;
          if (sentQueryCount > 1) {
            throw new Error("mock sent query failure");
          }
          return [sentOnlyZap];
        }
        return [sentOnlyZap, irrelevantZap];
      }
      return [];
    };
    poolProto.close = async () => {};

    try {
      const profileText = textFromResult(
        await getProfileHandler({ pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, relays: ["wss://mock"] }, {}),
      );
      expect(profileText).toContain("Profile for");
      expect(profileText).toContain("Name: Mock User");

      const notesText = textFromResult(
        await getKind1NotesHandler({ pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, limit: 10, relays: ["wss://mock"] }, {}),
      );
      expect(notesText).toContain("Found 2 notes");
      expect(notesText).toContain("newer note");

      const receivedZapsText = textFromResult(
        await getReceivedZapsHandler(
          { pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, limit: 10, relays: ["wss://mock"], validateReceipts: true, debug: true },
          {},
        ),
      );
      expect(receivedZapsText).toContain("Found");
      expect(receivedZapsText).toContain("Total received:");

      const sentZapsText = textFromResult(
        await getSentZapsHandler(
          { pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2, limit: 5, relays: ["wss://mock"], validateReceipts: true, debug: true },
          {},
        ),
      );
      expect(sentZapsText).toContain("Found");
      expect(sentZapsText).toContain("Total sent:");

      const allZapsText = textFromResult(
        await getAllZapsHandler(
          { pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, limit: 5, relays: ["wss://mock"], validateReceipts: true, debug: true },
          {},
        ),
      );
      expect(allZapsText).toContain("Zap Summary for");
      expect(allZapsText).toContain("Net balance:");

      const longFormText = textFromResult(
        await getLongFormNotesHandler({ pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, limit: 5, relays: ["wss://mock"] }, {}),
      );
      expect(longFormText).toContain("Found 1 long-form notes");
      expect(longFormText).toContain("Title: Mock Longform");
      expect(longFormText).toContain("Identifier: mock-article");
    } finally {
      poolProto.get = originalGet;
      poolProto.querySync = originalQuerySync;
      poolProto.close = originalClose;
    }
  });

  test("covers deterministic success formatting branches for local-only wrapper paths", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const signedNote = {
      id: DUMMY_EVENT_ID,
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: "hello",
      sig: "b".repeat(128),
    };

    const cases: Array<{ toolName: string; args: Record<string, unknown>; expectedText: string }> = [
      { toolName: "convertNip19", args: { input: DUMMY_HEX_PUBKEY, targetType: "npub" }, expectedText: "Conversion successful!" },
      { toolName: "analyzeNip19", args: { input: DUMMY_HEX_PUBKEY }, expectedText: "Analysis successful!" },
      { toolName: "createKeypair", args: { format: "both" }, expectedText: "Public Key (npub):" },
      { toolName: "createProfile", args: { privateKey: VALID_PRIVATE_KEY, name: "x", relays: [] }, expectedText: "Profile created successfully!" },
      { toolName: "updateProfile", args: { privateKey: VALID_PRIVATE_KEY, name: "x", relays: [] }, expectedText: "Profile updated successfully!" },
      { toolName: "postNote", args: { privateKey: VALID_PRIVATE_KEY, content: "hello", relays: [] }, expectedText: "Note posted successfully!" },
      { toolName: "createNote", args: { privateKey: VALID_PRIVATE_KEY, content: "hello", tags: [["t", "x"]] }, expectedText: "Note event created successfully!" },
      {
        toolName: "signNote",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          noteEvent: {
            pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            created_at: 1700000000,
            kind: 1,
            tags: [],
            content: "hello",
          },
        },
        expectedText: "Note signed successfully!",
      },
      { toolName: "publishNote", args: { signedNote, relays: [] }, expectedText: "Note published successfully!" },
      { toolName: "createNostrEvent", args: { kind: 1, content: "hello", privateKey: VALID_PRIVATE_KEY }, expectedText: "Unsigned Event:" },
      {
        toolName: "signNostrEvent",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          event: {
            pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            created_at: 1700000000,
            kind: 1,
            tags: [],
            content: "hello",
          },
        },
        expectedText: "Signed Event:",
      },
      {
        toolName: "encryptNip04",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
          plaintext: "hi",
        },
        expectedText: "?iv=",
      },
      {
        toolName: "decryptNip04",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
          ciphertext: "xQe8mMRFNwlkArLMWrrI4w==?iv=HxrCZxBUYWqJP4s3MmAawA==",
        },
        expectedText: "hi",
      },
      {
        toolName: "encryptNip44",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
          plaintext: "hi",
        },
        expectedText: "A",
      },
      {
        toolName: "decryptNip44",
        args: {
          privateKey: VALID_PRIVATE_KEY,
          senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
          ciphertext:
            "AgMkqoJ8n6ts2PG/3W+FaDZjrRTiHUZnywHZR04TVkvmyAfSYSUs0r2gDVk6jKS/mS79c0Vcgg2E9NbUvubDeUU8fGgBNn3L0OHPNhmxhC328NTgQbwFDCXJUCPjFuVc6GOS",
        },
        expectedText: "hi",
      },
    ];

    for (const c of cases) {
      const handler = getHandler(server, c.toolName);
      const result = await handler(c.args, {});
      const text = textFromResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(c.expectedText);
    }
  });

  test("covers query/contact/relay wrapper response formatting branches", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;

    const queryEventsHandler = getHandler(server, "queryEvents");
    const publishNostrEventHandler = getHandler(server, "publishNostrEvent");
    const followHandler = getHandler(server, "follow");
    const getContactListHandler = getHandler(server, "getContactList");
    const getFollowingHandler = getHandler(server, "getFollowing");
    const setRelayListHandler = getHandler(server, "setRelayList");
    const getRelayListHandler = getHandler(server, "getRelayList");
    const convertNip19Handler = getHandler(server, "convertNip19");

    const noEventsText = textFromResult(
      await queryEventsHandler({ relays: [relayUrl], kinds: [1], authors: [DUMMY_HEX_PUBKEY], limit: 3 }, {}),
    );
    expect(noEventsText).toContain("No events found.");

    const eventForQuery = await createGenericEvent({
      kind: 1,
      content: `index-wrapper-query-${Date.now()}`,
      tags: [["t", "wrapper-index"]],
      privateKey: VALID_PRIVATE_KEY,
    });
    expect(eventForQuery.success).toBe(true);
    expect(eventForQuery.event).toBeTruthy();

    const signedForQuery = await signGenericEvent({
      privateKey: VALID_PRIVATE_KEY,
      event: eventForQuery.event as any,
    });
    expect(signedForQuery.success).toBe(true);
    expect(signedForQuery.signedEvent).toBeTruthy();

    const publishQuerySeedText = textFromResult(
      await publishNostrEventHandler(
        {
          signedEvent: signedForQuery.signedEvent as any,
          relays: [relayUrl],
        },
        {},
      ),
    );
    expect(publishQuerySeedText).toContain("Event published to");

    const populatedEventsText = await pollForToolText(
      queryEventsHandler,
      { relays: [relayUrl], kinds: [1], authors: [VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1], limit: 10 },
      (text) => text.includes("Found") && text.includes("Content:"),
    );
    expect(populatedEventsText).toContain("Found");
    expect(populatedEventsText).toContain("Content:");

    const followText = textFromResult(
      await followHandler(
        {
          privateKey: VALID_PRIVATE_KEY,
          targetPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
          relayHint: relayUrl,
          petname: "peer-two",
          relays: [relayUrl],
        },
        {},
      ),
    );
    expect(followText).toContain("Following");

    const contactsText = await pollForToolText(
      getContactListHandler,
      { pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, relays: [relayUrl] },
      (text) => text.includes("Found") && text.includes("petname=peer-two"),
    );
    expect(contactsText).toContain("petname=peer-two");

    const followingText = await pollForToolText(
      getFollowingHandler,
      { pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, relays: [relayUrl] },
      (text) => text.includes("Found") && text.includes("petname=peer-two"),
    );
    expect(followingText).toContain("petname=peer-two");

    const setRelayListText = textFromResult(
      await setRelayListHandler(
        {
          privateKey: VALID_PRIVATE_KEY,
          relays: [relayUrl],
          relayList: [
            { url: "wss://relay.example.com", read: true, write: true },
            { url: "wss://read.example.com", read: true, write: false },
          ],
        },
        {},
      ),
    );
    expect(setRelayListText).toContain("Relay list published.");

    const relayListText = await pollForToolText(
      getRelayListHandler,
      { pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1, relays: [relayUrl] },
      (text) => text.includes("Found") && text.includes("wss://relay.example.com"),
    );
    expect(relayListText).toContain("- wss://relay.example.com (read,write)");
    expect(relayListText).toContain("- wss://read.example.com (read)");

    const nprofile = encodeProfile({
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      relays: ["wss://relay.example.com"],
    });
    const convertText = textFromResult(await convertNip19Handler({ input: nprofile, targetType: "npub" }, {}));
    expect(convertText).toContain("Conversion successful!");
    expect(convertText).toContain("Original entity data:");
  });

  test("covers DM wrapper response formatting branches for empty and populated states", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const getDmConversationHandler = getHandler(server, "getDmConversationNip04");
    const sendDmNip04Handler = getHandler(server, "sendDmNip04");
    const getDmInboxHandler = getHandler(server, "getDmInboxNip44");
    const sendDmNip44Handler = getHandler(server, "sendDmNip44");
    const decryptDmNip44Handler = getHandler(server, "decryptDmNip44");

    const emptyConversationText = textFromResult(
      await getDmConversationHandler(
        {
          privateKey: THIRD_PRIVATE_KEY,
          peerPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
          relays: [relayUrl],
          limit: 10,
          decrypt: true,
        },
        {},
      ),
    );
    expect(emptyConversationText).toContain("No messages.");

    const nip04Content = `index-wrapper-dm04-${Date.now()}`;
    const sendDm04Text = textFromResult(
      await sendDmNip04Handler(
        {
          privateKey: THIRD_PRIVATE_KEY,
          recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
          content: nip04Content,
          relays: [relayUrl],
        },
        {},
      ),
    );
    expect(sendDm04Text).toContain("Event published to");

    const populatedConversationText = await pollForToolText(
      getDmConversationHandler,
      {
        privateKey: THIRD_PRIVATE_KEY,
        peerPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
        relays: [relayUrl],
        limit: 10,
        decrypt: true,
      },
      (text) => text.includes("SENT") && text.includes(nip04Content),
    );
    expect(populatedConversationText).toContain("SENT");
    expect(populatedConversationText).toContain(nip04Content);

    const emptyInboxText = textFromResult(
      await getDmInboxHandler({ privateKey: FOURTH_PRIVATE_KEY, relays: [relayUrl], limit: 10 }, {}),
    );
    expect(emptyInboxText).toContain("No messages.");

    const nip44Content = `index-wrapper-dm44-${Date.now()}`;
    const sendDm44Text = textFromResult(
      await sendDmNip44Handler(
        {
          privateKey: THIRD_PRIVATE_KEY,
          recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
          content: nip44Content,
          relays: [relayUrl],
        },
        {},
      ),
    );
    expect(sendDm44Text).toContain("Event published to");

    const populatedInboxText = await pollForToolText(
      getDmInboxHandler,
      { privateKey: FOURTH_PRIVATE_KEY, relays: [relayUrl], limit: 25 },
      (text) => text.includes("FROM") && text.includes(nip44Content),
    );
    expect(populatedInboxText).toContain("FROM");
    expect(populatedInboxText).toContain(nip44Content);

    const wrapsDeadline = Date.now() + QUERY_TIMEOUT;
    let wraps = await queryEvents({
      relays: [relayUrl],
      kinds: [1059],
      tags: { p: [VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4] },
      limit: 10,
    });
    while (Date.now() < wrapsDeadline && (!wraps.success || (wraps.events ?? []).length === 0)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      wraps = await queryEvents({
        relays: [relayUrl],
        kinds: [1059],
        tags: { p: [VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4] },
        limit: 10,
      });
    }
    expect(wraps.success).toBe(true);
    expect((wraps.events ?? []).length).toBeGreaterThan(0);

    const decryptText = textFromResult(
      await decryptDmNip44Handler(
        {
          privateKey: FOURTH_PRIVATE_KEY,
          giftWrapEvent: (wraps.events ?? [])[0],
        },
        {},
      ),
    );
    expect(decryptText).toContain(`"content": "${nip44Content}"`);
  });

  test("covers profile/note wrapper formatting branches with optional fields and relay lists", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const createProfileHandler = getHandler(server, "createProfile");
    const updateProfileHandler = getHandler(server, "updateProfile");
    const postNoteHandler = getHandler(server, "postNote");
    const publishNoteHandler = getHandler(server, "publishNote");

    const createProfileText = textFromResult(
      await createProfileHandler(
        {
          privateKey: VALID_PRIVATE_KEY,
          name: "index-profile",
          about: "about text",
          picture: "https://example.com/pic.png",
          nip05: "name@example.com",
          lud16: "name@ln.example.com",
          lud06: "lnurl1dp68gurn8ghj7",
          website: "https://example.com",
          relays: [],
        },
        {},
      ),
    );
    expect(createProfileText).toContain("Profile created successfully!");
    expect(createProfileText).toContain("Name: index-profile");
    expect(createProfileText).toContain("About: about text");
    expect(createProfileText).toContain("Picture: https://example.com/pic.png");
    expect(createProfileText).toContain("NIP-05: name@example.com");
    expect(createProfileText).toContain("Lightning Address: name@ln.example.com");
    expect(createProfileText).toContain("LNURL: lnurl1dp68gurn8ghj7");
    expect(createProfileText).toContain("Website: https://example.com");

    const updateProfileText = textFromResult(
      await updateProfileHandler(
        {
          privateKey: VALID_PRIVATE_KEY,
          name: "index-profile-updated",
          about: "updated about",
          picture: "https://example.com/new.png",
          nip05: "new@example.com",
          lud16: "new@ln.example.com",
          lud06: "lnurl1dp68gurn8ghk9",
          website: "https://updated.example.com",
          relays: [],
        },
        {},
      ),
    );
    expect(updateProfileText).toContain("Profile updated successfully!");
    expect(updateProfileText).toContain("Updated profile data:");
    expect(updateProfileText).toContain("Name: index-profile-updated");
    expect(updateProfileText).toContain("About: updated about");
    expect(updateProfileText).toContain("Picture: https://example.com/new.png");
    expect(updateProfileText).toContain("NIP-05: new@example.com");
    expect(updateProfileText).toContain("Lightning Address: new@ln.example.com");
    expect(updateProfileText).toContain("LNURL: lnurl1dp68gurn8ghk9");
    expect(updateProfileText).toContain("Website: https://updated.example.com");

    const postNoteText = textFromResult(
      await postNoteHandler(
        {
          privateKey: VALID_PRIVATE_KEY,
          content: `wrapper-note-${Date.now()}`,
          tags: [["t", "offline-branch"]],
          relays: [],
        },
        {},
      ),
    );
    expect(postNoteText).toContain("Note posted successfully!");
    expect(postNoteText).toContain("Tags:");

    const created = await createUnsignedNote(VALID_PRIVATE_KEY, `publish-wrapper-${Date.now()}`, [["t", "publish-wrapper"]]);
    expect(created.success).toBe(true);
    expect(created.noteEvent).toBeTruthy();

    const signed = await signLocalNote(VALID_PRIVATE_KEY, created.noteEvent as any);
    expect(signed.success).toBe(true);
    expect(signed.signedNote).toBeTruthy();

    const publishText = textFromResult(
      await publishNoteHandler({ signedNote: signed.signedNote as any, relays: [] }, {}),
    );
    expect(publishText).toContain("Note published successfully!");
  });

  test("covers additional wrapper success paths for anonymous zaps and relay-list rendering", async () => {
    const server = createNostrMcpServer() as unknown as FakeMcpServer;
    const sendAnonymousZapHandler = getHandler(server, "sendAnonymousZap");
    const postAnonymousNoteHandler = getHandler(server, "postAnonymousNote");
    const postNoteHandler = getHandler(server, "postNote");
    const publishNoteHandler = getHandler(server, "publishNote");

    const poolProto = CompatibleRelayPool.prototype as any;
    const originalGet = poolProto.get;
    const originalClose = poolProto.close;
    const originalPublish = poolProto.publish;
    const originalFetch = globalThis.fetch;

    poolProto.get = async (_relays: string[], filter: any) => {
      if (Array.isArray(filter?.kinds) && filter.kinds.includes(KINDS.Metadata)) {
        return {
          id: "profile-for-anon-zap",
          pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
          created_at: Math.floor(Date.now() / 1000),
          kind: KINDS.Metadata,
          tags: [],
          content: JSON.stringify({ lightningAddress: "alice@example.com" }),
          sig: "f".repeat(128),
        };
      }
      return null;
    };
    poolProto.close = async () => {};
    poolProto.publish = (relays: string[]) => relays.map(() => Promise.resolve({ success: true }));

    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/.well-known/lnurlp/alice")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              callback: "https://wallet.example/cb",
              maxSendable: 21_000_000,
              minSendable: 1_000,
              metadata: '[["text/plain","Alice"]]',
              nostrPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
              allowsNostr: true,
              commentAllowed: 140,
            }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ pr: "lnbc1wrappedinvoice", routes: [] }),
      } as any;
    };

    try {
      const anonymousZapText = textFromResult(
        await sendAnonymousZapHandler(
          {
            target: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            amountSats: 21,
            comment: "wrapped success",
            relays: [relayUrl],
          },
          {},
        ),
      );
      expect(anonymousZapText).toContain("Anonymous zap prepared successfully!");
      expect(anonymousZapText).toContain("Invoice:");
      expect(anonymousZapText).toContain("lnbc1wrappedinvoice");

      const anonymousNoteText = textFromResult(
        await postAnonymousNoteHandler(
          {
            content: `wrapped-anon-note-${Date.now()}`,
            relays: [relayUrl],
            tags: [["t", "wrapped-anon"]],
          },
          {},
        ),
      );
      expect(anonymousNoteText).toContain("Anonymous note posted successfully!");
      expect(anonymousNoteText).toContain("Tags:");
      expect(anonymousNoteText).toContain(`Relays: ${relayUrl}`);

      const postNoteText = textFromResult(
        await postNoteHandler(
          {
            privateKey: VALID_PRIVATE_KEY,
            content: `wrapped-post-note-${Date.now()}`,
            relays: [relayUrl],
          },
          {},
        ),
      );
      expect(postNoteText).toContain("Note posted successfully!");
      expect(postNoteText).toContain(`Relays: ${relayUrl}`);

      const created = await createUnsignedNote(VALID_PRIVATE_KEY, `wrapped-publish-note-${Date.now()}`, []);
      expect(created.success).toBe(true);
      expect(created.noteEvent).toBeTruthy();

      const signed = await signLocalNote(VALID_PRIVATE_KEY, created.noteEvent as any);
      expect(signed.success).toBe(true);
      expect(signed.signedNote).toBeTruthy();

      const publishNoteText = textFromResult(
        await publishNoteHandler(
          {
            signedNote: signed.signedNote as any,
            relays: [relayUrl],
          },
          {},
        ),
      );
      expect(publishNoteText).toContain("Note published successfully!");
      expect(publishNoteText).toContain(`Relays: ${relayUrl}`);
    } finally {
      poolProto.get = originalGet;
      poolProto.close = originalClose;
      poolProto.publish = originalPublish;
      (globalThis as any).fetch = originalFetch;
    }
  });

  test("normalizes anonymous zap network and timeout error messages", () => {
    const enotfound = normalizeAnonymousZapErrorMessage(new Error("getaddrinfo ENOTFOUND wallet.example.test"));
    expect(enotfound).toContain("Could not connect to the Lightning service.");
    expect(enotfound).toContain("ENOTFOUND");

    const etimedout = normalizeAnonymousZapErrorMessage(new Error("connect ETIMEDOUT 1.2.3.4:443"));
    expect(etimedout).toContain("Could not connect to the Lightning service.");
    expect(etimedout).toContain("ETIMEDOUT");

    const timeout = normalizeAnonymousZapErrorMessage(new Error("Timeout"));
    expect(timeout).toContain("The operation timed out.");

    const generic = normalizeAnonymousZapErrorMessage(new Error("something else"));
    expect(generic).toBe("something else");
  });

  test("covers sent-zap response helper filtering and summary branches", () => {
    const sentZap = {
      id: "sent-zap-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
      created_at: 1700000002,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            amountMsats: 21000,
            content: "sent fixture",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const nonSentZap = {
      id: "non-sent-zap-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
      created_at: 1700000001,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_1,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            amountMsats: 14000,
            content: "non-sent fixture",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const invalidSentZap = {
      id: "invalid-sent-zap-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
      created_at: 1700000003,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            amountMsats: 33000,
            content: "invalid fixture (missing bolt11)",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };

    const summaryText = buildSentZapsResponseText({
      potentialSentZaps: [sentZap as any, nonSentZap as any, sentZap as any],
      hexPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
      displayPubkey: "npub-context-3",
      limit: 2,
      validateReceipts: false,
      debug: true,
    });
    expect(summaryText).toContain("Found 1 zaps sent by npub-context-3.");
    expect(summaryText).toContain("Total sent: 21 sats");
    expect(summaryText).toContain("SENT");

    const filteredText = buildSentZapsResponseText({
      potentialSentZaps: [invalidSentZap as any, nonSentZap as any],
      hexPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_4,
      displayPubkey: "npub-context-4",
      limit: 2,
      validateReceipts: true,
      debug: true,
    });
    expect(filteredText).toContain("No zaps sent by npub-context-4 were found.");
    expect(filteredText).toContain("invalid zaps and");
    expect(filteredText).toContain("non-sent zaps were filtered out");
    expect(filteredText).toContain("This could be because:");
  });

  test("covers all-zap response helper summary and filtered-empty branches", () => {
    const sentZap = {
      id: "all-sent-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
      created_at: 1700000004,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            amountMsats: 1000,
            content: "all-zaps sent",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const receivedZap = {
      id: "all-received-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
      created_at: 1700000005,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
            amountMsats: 2000,
            content: "all-zaps received",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const selfZap = {
      id: "all-self-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
      created_at: 1700000006,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
            amountMsats: 3000,
            content: "all-zaps self",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const irrelevantZap = {
      id: "all-irrelevant-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
      created_at: 1700000007,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3],
        ["bolt11", "invalid-bolt11"],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_3,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            amountMsats: 4000,
            content: "all-zaps irrelevant",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };
    const invalidRelevantZap = {
      id: "all-invalid-relevant-id",
      pubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
      created_at: 1700000008,
      kind: 9735,
      tags: [
        ["p", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_6],
        ["P", VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2],
        [
          "description",
          buildZapDescription({
            senderPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_2,
            recipientPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_6,
            amountMsats: 6000,
            content: "all-zaps invalid-missing-bolt11",
          }),
        ],
      ],
      content: "",
      sig: "f".repeat(128),
    };

    const summaryText = buildAllZapsResponseText({
      allZaps: [sentZap as any, receivedZap as any, selfZap as any, irrelevantZap as any, sentZap as any],
      hexPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_5,
      displayPubkey: "npub-context-5",
      limit: 3,
      validateReceipts: false,
      debug: true,
    });
    expect(summaryText).toContain("- 1 zaps sent (1 sats)");
    expect(summaryText).toContain("- 1 zaps received (2 sats)");
    expect(summaryText).toContain("- 1 self-zaps (3 sats)");
    expect(summaryText).toContain("Net balance: 1 sats");
    expect(summaryText).toContain("Showing 3 most recent zaps:");

    const filteredText = buildAllZapsResponseText({
      allZaps: [irrelevantZap as any, invalidRelevantZap as any],
      hexPubkey: VALID_PUBLIC_KEY_FOR_PRIVATE_KEY_6,
      displayPubkey: "npub-context-6",
      limit: 5,
      validateReceipts: true,
      debug: true,
    });
    expect(filteredText).toContain("No relevant zaps found for npub-context-6.");
    expect(filteredText).toContain("invalid zaps and");
    expect(filteredText).toContain("irrelevant zaps were filtered out");
  });

  test("startMcpStdioServer connects server to stdio transport", async () => {
    const stderrSpy = mock(() => {});
    const originalStderr = console.error;
    console.error = stderrSpy as any;

    try {
      await startMcpStdioServer();
    } finally {
      console.error = originalStderr;
    }

    expect(createdTransports.length).toBe(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith(createdTransports[0]);
    expect(stderrSpy).toHaveBeenCalledWith("Nostr Agent Interface (MCP mode) running on stdio");
  });
});
