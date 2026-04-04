import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const VALID_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
const ALT_PRIVATE_KEY = "0000000000000000000000000000000000000000000000000000000000000002";
const DUMMY_HEX_PUBKEY = "f".repeat(64);
const DUMMY_EVENT_ID = "a".repeat(64);
const MCP_ENTRYPOINT = path.resolve(process.cwd(), "app/index.ts");
const MCP_SERVER_PROCESS: StdioServerParameters = {
  command: process.execPath,
  args: [MCP_ENTRYPOINT, "mcp"],
  cwd: process.cwd(),
  stderr: "pipe",
};
const MCP_CLIENT_INFO = {
  name: "nostr-agent-interface-dispatch-tests",
  version: "0.1.0",
};

type ManagedMcpClient = {
  client: Client;
  close: () => Promise<void>;
};

async function createManagedMcpClient(serverProcess: StdioServerParameters = MCP_SERVER_PROCESS): Promise<ManagedMcpClient> {
  const transport = new StdioClientTransport(serverProcess);
  const client = new Client(MCP_CLIENT_INFO);

  if (transport.stderr) {
    transport.stderr.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") {
        process.stderr.write(chunk);
        return;
      }
      if (chunk instanceof Uint8Array) {
        process.stderr.write(chunk);
      }
    });
  }

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), transport.close()]);
    },
  };
}

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

const EXPECTED_TOOL_INPUT_SCHEMAS: Record<string, {
  required: string[];
  properties: string[];
  propertyTypes: Record<string, string>;
  arrayItemTypes?: Record<string, string>;
  enums?: Record<string, string[]>;
  nestedProperties?: Record<string, string[]>;
}> = {
  "analyzeNip19": {
    required: ["input"],
    properties: ["input"],
    propertyTypes: {"input":"string"},
  },
  "convertNip19": {
    required: ["input","targetType"],
    properties: ["author","identifier","input","kind","relays","targetType"],
    propertyTypes: {"input":"string","targetType":"string","relays":"array","author":"string","kind":"number","identifier":"string"},
    arrayItemTypes: {"relays":"string"},
    enums: {"targetType":["npub","nsec","note","hex","nprofile","nevent","naddr"]},
  },
  "createKeypair": {
    required: [],
    properties: ["format"],
    propertyTypes: {"format":"string"},
    enums: {"format":["both","hex","npub"]},
  },
  "createNostrEvent": {
    required: ["kind"],
    properties: ["content","createdAt","kind","privateKey","pubkey","tags"],
    propertyTypes: {"kind":"integer","content":"string","tags":"array","createdAt":"integer","pubkey":"string","privateKey":"string"},
    arrayItemTypes: {"tags":"array"},
  },
  "createNote": {
    required: ["content","privateKey"],
    properties: ["content","privateKey","tags"],
    propertyTypes: {"privateKey":"string","content":"string","tags":"array"},
    arrayItemTypes: {"tags":"array"},
  },
  "createProfile": {
    required: ["privateKey"],
    properties: ["about","lud06","lud16","name","nip05","picture","privateKey","relays","website"],
    propertyTypes: {"privateKey":"string","name":"string","about":"string","picture":"string","nip05":"string","lud16":"string","lud06":"string","website":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "decryptDmNip44": {
    required: ["giftWrapEvent","privateKey"],
    properties: ["giftWrapEvent","privateKey"],
    propertyTypes: {"privateKey":"string","giftWrapEvent":"object"},
    nestedProperties: {"giftWrapEvent":["content","created_at","id","kind","pubkey","sig","tags"]},
  },
  "decryptNip04": {
    required: ["ciphertext","privateKey","senderPubkey"],
    properties: ["ciphertext","privateKey","senderPubkey"],
    propertyTypes: {"privateKey":"string","senderPubkey":"string","ciphertext":"string"},
  },
  "decryptNip44": {
    required: ["ciphertext","privateKey","senderPubkey"],
    properties: ["ciphertext","privateKey","senderPubkey"],
    propertyTypes: {"privateKey":"string","senderPubkey":"string","ciphertext":"string"},
  },
  "deleteBlob": {
    required: ["privateKey","sha256"],
    properties: ["privateKey","relays","serverUrl","sha256"],
    propertyTypes: {"privateKey":"string","sha256":"string","serverUrl":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "deleteEvent": {
    required: ["privateKey","targets"],
    properties: ["privateKey","reason","relays","targets"],
    propertyTypes: {"privateKey":"string","targets":"array","reason":"string","relays":"array"},
    arrayItemTypes: {"targets":"string","relays":"string"},
  },
  "downloadBlob": {
    required: ["sha256"],
    properties: ["outputPath","privateKey","relays","serverUrl","sha256"],
    propertyTypes: {"sha256":"string","serverUrl":"string","privateKey":"string","relays":"array","outputPath":"string"},
    arrayItemTypes: {"relays":"string"},
  },
  "encryptNip04": {
    required: ["plaintext","privateKey","recipientPubkey"],
    properties: ["plaintext","privateKey","recipientPubkey"],
    propertyTypes: {"privateKey":"string","recipientPubkey":"string","plaintext":"string"},
  },
  "encryptNip44": {
    required: ["plaintext","privateKey","recipientPubkey"],
    properties: ["plaintext","privateKey","recipientPubkey","version"],
    propertyTypes: {"privateKey":"string","recipientPubkey":"string","plaintext":"string","version":"integer"},
  },
  "follow": {
    required: ["privateKey","targetPubkey"],
    properties: ["petname","privateKey","relayHint","relays","targetPubkey"],
    propertyTypes: {"privateKey":"string","targetPubkey":"string","relayHint":"string","petname":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getAllZaps": {
    required: ["pubkey"],
    properties: ["debug","limit","pubkey","relays","since","until","validateReceipts"],
    propertyTypes: {"pubkey":"string","limit":"number","since":"integer","until":"integer","relays":"array","validateReceipts":"boolean","debug":"boolean"},
    arrayItemTypes: {"relays":"string"},
  },
  "getBlossomServers": {
    required: [],
    properties: ["authPrivateKey","privateKey","pubkey","relays"],
    propertyTypes: {"pubkey":"string","privateKey":"string","relays":"array","authPrivateKey":"string"},
    arrayItemTypes: {"relays":"string"},
  },
  "getBlossomUrl": {
    required: ["sha256"],
    properties: ["privateKey","relays","serverUrl","sha256"],
    propertyTypes: {"sha256":"string","serverUrl":"string","privateKey":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getContactList": {
    required: ["pubkey"],
    properties: ["pubkey","relays"],
    propertyTypes: {"pubkey":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getDmConversationNip04": {
    required: ["peerPubkey","privateKey"],
    properties: ["authPrivateKey","decrypt","limit","peerPubkey","privateKey","relays","since","until"],
    propertyTypes: {"privateKey":"string","peerPubkey":"string","relays":"array","authPrivateKey":"string","since":"integer","until":"integer","limit":"integer","decrypt":"boolean"},
    arrayItemTypes: {"relays":"string"},
  },
  "getDmInboxNip44": {
    required: ["privateKey"],
    properties: ["authPrivateKey","limit","privateKey","relays","since","until"],
    propertyTypes: {"privateKey":"string","relays":"array","authPrivateKey":"string","since":"integer","until":"integer","limit":"integer"},
    arrayItemTypes: {"relays":"string"},
  },
  "getFollowing": {
    required: ["pubkey"],
    properties: ["pubkey","relays"],
    propertyTypes: {"pubkey":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getKind1Notes": {
    required: ["pubkey"],
    properties: ["limit","pubkey","relays","since","until"],
    propertyTypes: {"pubkey":"string","limit":"number","since":"integer","until":"integer","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getLongFormNotes": {
    required: ["pubkey"],
    properties: ["limit","pubkey","relays","since","until"],
    propertyTypes: {"pubkey":"string","limit":"number","since":"integer","until":"integer","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getProfile": {
    required: ["pubkey"],
    properties: ["pubkey","relays"],
    propertyTypes: {"pubkey":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "getReceivedZaps": {
    required: ["pubkey"],
    properties: ["debug","limit","pubkey","relays","since","until","validateReceipts"],
    propertyTypes: {"pubkey":"string","limit":"number","since":"integer","until":"integer","relays":"array","validateReceipts":"boolean","debug":"boolean"},
    arrayItemTypes: {"relays":"string"},
  },
  "getRelayList": {
    required: ["pubkey"],
    properties: ["authPrivateKey","pubkey","relays"],
    propertyTypes: {"pubkey":"string","relays":"array","authPrivateKey":"string"},
    arrayItemTypes: {"relays":"string"},
  },
  "getSentZaps": {
    required: ["pubkey"],
    properties: ["debug","limit","pubkey","relays","since","until","validateReceipts"],
    propertyTypes: {"pubkey":"string","limit":"number","since":"integer","until":"integer","relays":"array","validateReceipts":"boolean","debug":"boolean"},
    arrayItemTypes: {"relays":"string"},
  },
  "listBlobs": {
    required: [],
    properties: ["limit","privateKey","pubkey","relays","serverUrl"],
    propertyTypes: {"privateKey":"string","pubkey":"string","serverUrl":"string","relays":"array","limit":"integer"},
    arrayItemTypes: {"relays":"string"},
  },
  "mirrorBlob": {
    required: ["privateKey","sourceUrl"],
    properties: ["privateKey","relays","serverUrl","sourceUrl"],
    propertyTypes: {"privateKey":"string","sourceUrl":"string","serverUrl":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "postAnonymousNote": {
    required: ["content"],
    properties: ["content","relays","tags"],
    propertyTypes: {"content":"string","relays":"array","tags":"array"},
    arrayItemTypes: {"relays":"string","tags":"array"},
  },
  "postNote": {
    required: ["content","privateKey"],
    properties: ["content","privateKey","relays","tags"],
    propertyTypes: {"privateKey":"string","content":"string","tags":"array","relays":"array"},
    arrayItemTypes: {"tags":"array","relays":"string"},
  },
  "publishNostrEvent": {
    required: ["signedEvent"],
    properties: ["authPrivateKey","relays","signedEvent"],
    propertyTypes: {"relays":"array","authPrivateKey":"string","signedEvent":"object"},
    arrayItemTypes: {"relays":"string"},
    nestedProperties: {"signedEvent":["content","created_at","id","kind","pubkey","sig","tags"]},
  },
  "publishNote": {
    required: ["signedNote"],
    properties: ["relays","signedNote"],
    propertyTypes: {"signedNote":"object","relays":"array"},
    arrayItemTypes: {"relays":"string"},
    nestedProperties: {"signedNote":["content","created_at","id","kind","pubkey","sig","tags"]},
  },
  "queryEvents": {
    required: [],
    properties: ["authPrivateKey","authors","ids","kinds","limit","relays","search","since","tags","until"],
    propertyTypes: {"relays":"array","authPrivateKey":"string","kinds":"array","authors":"array","ids":"array","since":"integer","until":"integer","limit":"integer","tags":"object","search":"string"},
    arrayItemTypes: {"relays":"string","kinds":"integer","authors":"string","ids":"string"},
  },
  "reactToEvent": {
    required: ["privateKey","target"],
    properties: ["privateKey","reaction","relays","target"],
    propertyTypes: {"privateKey":"string","target":"string","reaction":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "replyToEvent": {
    required: ["content","privateKey","target"],
    properties: ["content","privateKey","relays","tags","target"],
    propertyTypes: {"privateKey":"string","target":"string","content":"string","tags":"array","relays":"array"},
    arrayItemTypes: {"tags":"array","relays":"string"},
  },
  "repostEvent": {
    required: ["privateKey","target"],
    properties: ["privateKey","relays","target"],
    propertyTypes: {"privateKey":"string","target":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "sendAnonymousZap": {
    required: ["amountSats","target"],
    properties: ["amountSats","comment","relays","target"],
    propertyTypes: {"target":"string","amountSats":"number","comment":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "sendDmNip04": {
    required: ["content","privateKey","recipientPubkey"],
    properties: ["authPrivateKey","content","createdAt","privateKey","recipientPubkey","relays"],
    propertyTypes: {"privateKey":"string","recipientPubkey":"string","content":"string","relays":"array","authPrivateKey":"string","createdAt":"integer"},
    arrayItemTypes: {"relays":"string"},
  },
  "sendDmNip44": {
    required: ["content","privateKey","recipientPubkey"],
    properties: ["authPrivateKey","content","privateKey","recipientPubkey","relays"],
    propertyTypes: {"privateKey":"string","recipientPubkey":"string","content":"string","relays":"array","authPrivateKey":"string"},
    arrayItemTypes: {"relays":"string"},
  },
  "setBlossomServers": {
    required: ["privateKey","servers"],
    properties: ["privateKey","relays","servers"],
    propertyTypes: {"privateKey":"string","servers":"array","relays":"array"},
    arrayItemTypes: {"servers":"string","relays":"string"},
  },
  "setRelayList": {
    required: ["privateKey","relayList"],
    properties: ["privateKey","relayList","relays"],
    propertyTypes: {"privateKey":"string","relayList":"array","relays":"array"},
    arrayItemTypes: {"relayList":"object","relays":"string"},
  },
  "signNostrEvent": {
    required: ["event","privateKey"],
    properties: ["event","privateKey"],
    propertyTypes: {"privateKey":"string","event":"object"},
    nestedProperties: {"event":["content","created_at","kind","pubkey","tags"]},
  },
  "signNote": {
    required: ["noteEvent","privateKey"],
    properties: ["noteEvent","privateKey"],
    propertyTypes: {"privateKey":"string","noteEvent":"object"},
    nestedProperties: {"noteEvent":["content","created_at","kind","pubkey","tags"]},
  },
  "unfollow": {
    required: ["privateKey","targetPubkey"],
    properties: ["privateKey","relays","targetPubkey"],
    propertyTypes: {"privateKey":"string","targetPubkey":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "updateProfile": {
    required: ["privateKey"],
    properties: ["about","lud06","lud16","name","nip05","picture","privateKey","relays","website"],
    propertyTypes: {"privateKey":"string","name":"string","about":"string","picture":"string","nip05":"string","lud16":"string","lud06":"string","website":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
  "uploadBlob": {
    required: ["privateKey"],
    properties: ["content","contentType","filePath","privateKey","relays","serverUrl"],
    propertyTypes: {"privateKey":"string","filePath":"string","content":"string","contentType":"string","serverUrl":"string","relays":"array"},
    arrayItemTypes: {"relays":"string"},
  },
};


function textFromResult(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function schemaTypeOf(schema: any): string {
  if (!schema) return "(none)";
  if (Array.isArray(schema.type)) return schema.type.join("|");
  return schema.type ?? "(none)";
}

function schemaArrayItemTypeOf(schema: any): string {
  const items = schema?.items;
  if (!items) return "(none)";
  if (Array.isArray(items.type)) return items.type.join("|");
  if (items.type) return items.type;
  if (items.properties) return "object";
  return "(none)";
}

type DispatchCase = {
  toolName: string;
  args: Record<string, unknown>;
  expectedText: string;
};

describe("MCP dispatch coverage", () => {
  let managed: ManagedMcpClient | undefined;

  beforeAll(async () => {
    managed = await createManagedMcpClient();
  });

  afterAll(async () => {
    await managed?.close();
    managed = undefined;
  });

  test("registers the complete MCP tool catalog", async () => {
    const list = await managed!.client.listTools();
    const names = (list.tools ?? []).map((tool: any) => tool.name).sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  test("exposes stable input schema contracts for all tools", async () => {
    const list = await managed!.client.listTools();
    const toolsByName = new Map((list.tools ?? []).map((tool: any) => [tool.name, tool]));
    expect(Array.from(toolsByName.keys()).sort()).toEqual(EXPECTED_TOOL_NAMES);
    expect(Object.keys(EXPECTED_TOOL_INPUT_SCHEMAS).sort()).toEqual(EXPECTED_TOOL_NAMES);

    for (const toolName of EXPECTED_TOOL_NAMES) {
      const tool = toolsByName.get(toolName);
      expect(tool).toBeDefined();

      const expected = EXPECTED_TOOL_INPUT_SCHEMAS[toolName];
      const schema = tool.inputSchema ?? {};

      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);

      const required = Array.isArray(schema.required) ? schema.required.slice().sort() : [];
      const propertiesObj = schema.properties ?? {};
      const propertyNames = Object.keys(propertiesObj).sort();

      expect(required).toEqual(expected.required);
      expect(propertyNames).toEqual(expected.properties);

      for (const propertyName of expected.properties) {
        const propertySchema = propertiesObj[propertyName];
        expect(propertySchema).toBeDefined();
        expect(schemaTypeOf(propertySchema)).toBe(expected.propertyTypes[propertyName]);

        if (expected.arrayItemTypes?.[propertyName]) {
          expect(schemaArrayItemTypeOf(propertySchema)).toBe(expected.arrayItemTypes[propertyName]);
        }

        if (expected.enums?.[propertyName]) {
          expect(propertySchema.enum).toEqual(expected.enums[propertyName]);
        }

        if (expected.nestedProperties?.[propertyName]) {
          const nestedNames = Object.keys(propertySchema?.properties ?? {}).sort();
          const nestedRequired = Array.isArray(propertySchema?.required) ? propertySchema.required.slice().sort() : [];
          expect(nestedNames).toEqual(expected.nestedProperties[propertyName]);
          expect(nestedRequired).toEqual(expected.nestedProperties[propertyName]);
          expect(propertySchema.additionalProperties).toBe(false);
        }
      }
    }

    const relayListItemSchema = toolsByName.get("setRelayList")?.inputSchema?.properties?.relayList?.items;
    expect(schemaTypeOf(relayListItemSchema)).toBe("object");
    expect(Object.keys(relayListItemSchema?.properties ?? {}).sort()).toEqual(["read", "url", "write"]);
    expect((relayListItemSchema?.required ?? []).slice().sort()).toEqual(["url"]);
    expect(relayListItemSchema?.additionalProperties).toBe(false);
  });

  test("routes all tool handlers on deterministic validation/success paths", async () => {
    const cases: DispatchCase[] = [
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
      { toolName: "postAnonymousNote", args: { content: "hello", relays: [] }, expectedText: "Failed to post anonymous note" },
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
          relays: ["wss://relay.example.com"],
          authPrivateKey: "bad_private_key",
        },
        expectedText: "Invalid private key format",
      },
    ];

    for (const c of cases) {
      const result = await managed!.client.callTool({ name: c.toolName, arguments: c.args });
      const text = textFromResult(result);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(c.expectedText);
    }
  });
});
