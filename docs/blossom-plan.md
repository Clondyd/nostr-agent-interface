# Blossom Integration Plan

Port all Blossom (BUD-01 through BUD-06) file storage functionality from [blup](https://github.com/futurepaul/blup) into nostr-agent-interface.

## What blup does

Blossom is a protocol for storing blobs (files) on servers, authenticated via Nostr keypairs (kind 24242 auth events). blup implements:

### Core Blossom operations
1. **Upload blob** — upload a file to a Blossom server (PUT /upload with auth, BUD-06 preflight)
2. **List blobs** — list blobs owned by a pubkey (GET /list/<pubkey>)
3. **Delete blob** — delete a blob by sha256 hash (DELETE /<sha256>)
4. **Mirror blob** — mirror a URL to your Blossom server (PUT /mirror, with download+reupload fallback)

### Server management (kind 10063)
5. **Fetch server list** — read a user's Blossom server list from relays (kind 10063)
6. **Publish server list** — publish/update Blossom server list to relays
7. **Add server** — add a new Blossom server to the list
8. **List servers** — display configured servers
9. **Set preferred server** — reorder server priority

### Auth
10. **Create auth event** — build kind 24242 auth events for list/upload/delete operations

## What NAI already has

- Profile management (kind 0) — overlaps with blup's profile commands; **skip** those
- Relay list management (kind 10002) — overlaps; **skip**
- Key handling via snstr — replaces blup's keychain approach
- Event creation/signing — can reuse for kind 24242 auth events

## New module: `blossom/`

Create `blossom/blossom-tools.ts` following NAI's existing module pattern.

### New tools to register (8 tools)

| Tool name | blup source | Description |
|---|---|---|
| `getBlossomServers` | `fetchServerList` + `getServers` | Fetch a user's Blossom server list (kind 10063) |
| `setBlossomServers` | `publishServerList` + `addServer` | Publish/update Blossom server list |
| `uploadBlob` | `uploadBlob` + `uploadBytes` | Upload a file (path or raw bytes) to a Blossom server |
| `downloadBlob` | (new) | Download a blob by hash from a server (GET /<sha256>) |
| `listBlobs` | `listBlobs` | List blobs for a pubkey on a server |
| `deleteBlob` | `deleteBlob` | Delete a blob by sha256 |
| `mirrorBlob` | `mirrorBlob` | Mirror a URL to a Blossom server (with fallback) |
| `getBlossomUrl` | (new helper) | Resolve a blob's URL given sha256 + server |

### Implementation notes

#### Auth (kind 24242)
- blup builds auth events with `finalizeEvent` from nostr-tools
- NAI uses snstr — port to snstr's signing/event creation
- Auth event structure: kind 24242, tags: `["t", type]`, `["expiration", ts]`, optional `["x", sha256]`
- Auth header format: `Nostr ${base64(JSON.stringify(signedEvent))}`

#### SHA-256 hashing
- blup uses `new Bun.SHA256()` — replace with Node.js `crypto.createHash('sha256')` or snstr equivalent for portability

#### Upload flow (BUD-06)
1. Hash the file content (SHA-256)
2. Create kind 24242 auth event with `["t", "upload"]` + `["x", hash]`
3. HEAD preflight to `/upload` with `X-SHA-256`, `X-Content-Type`, `X-Content-Length`
4. PUT to `/upload` with auth header + file body
5. Return `{ url, sha256, size, type }`

#### Mirror flow
1. Try PUT to `/mirror` with `{ url: sourceUrl }` body
2. If server returns 404 (no mirror support), download source + reupload
3. Return blob metadata

#### File reading
- blup uses `Bun.file()` — replace with Node.js `fs.readFile` / `Buffer`
- Content type detection: use file extension mapping or a lightweight mime lib

#### Server list (kind 10063)
- Tags: `["server", url]` for each server, first = preferred
- Query relays for kind 10063 by pubkey, take most recent
- Cache locally to avoid repeated relay lookups

### Zod schemas

```typescript
// Input schemas
const uploadBlobSchema = z.object({
  filePath: z.string().optional(),
  content: z.string().optional().describe("Base64-encoded file content"),
  contentType: z.string().optional().default("application/octet-stream"),
  serverUrl: z.string().url().optional().describe("Override default server"),
});

const listBlobsSchema = z.object({
  pubkey: z.string().optional().describe("Pubkey to list blobs for (default: self)"),
  serverUrl: z.string().url().optional(),
  limit: z.number().optional().default(10),
});

const deleteBlobSchema = z.object({
  sha256: z.string(),
  serverUrl: z.string().url().optional(),
});

const mirrorBlobSchema = z.object({
  sourceUrl: z.string().url(),
  serverUrl: z.string().url().optional(),
});

const getBlossomServersSchema = z.object({
  pubkey: z.string().optional(),
});

const setBlossomServersSchema = z.object({
  servers: z.array(z.string().url()),
});
```

## Integration checklist

Current PR status: Blossom tooling is now registered in `index.ts`, exposed through the existing CLI/API surfaces in `app/cli.ts` and `app/api.ts`, and reflected in `artifacts/tools.json`. Dedicated Blossom tests and README coverage are still pending.

- [x] Create `blossom/` directory
- [x] Implement `blossom/blossom-tools.ts` with all 8 tools
- [x] Register tools in `index.ts` (shared tool surface)
- [x] Expose Blossom tools through the existing CLI in `app/cli.ts`
- [x] Expose Blossom tools through the existing API in `app/api.ts`
- [ ] Write Blossom-specific tests (unit + integration against mock server or blossom.band)
- [x] Update `artifacts/tools.json` via `bun run build`
- [x] Update `CLAUDE.md` tool count
- [ ] Update README.md with a Blossom section

## What we skip from blup

- **Account/keypair management** — NAI handles keys via env/snstr
- **Profile commands** — NAI already has `createProfile` / `updateProfile` / `getProfile`
- **Relay list publishing** — NAI already has `setRelayList` / `getRelayList`
- **CLI chrome** (progress bars, terminal image display, interactive prompts)
- **Config file caching** — NAI manages state differently

## Dependencies

- No new deps needed — snstr + Node crypto should cover everything
- If mime type detection is wanted: consider `mime` package (tiny) or a simple extension map
