# Nostr Agent Interface

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Nostr Agent Interface extends the original **Nostr MCP Server**.

Nostr MCP Server established the core JARC-style Nostr toolset (stable tool names + JSON input contracts). This project keeps that same core contract and exposes it through direct **CLI** and **HTTP API** runtimes as the default operational interfaces, with **MCP** remaining a separate compatibility mode.

## Positioning

1. **Nostr MCP Server remains valid on its own** and is not being deprecated by this project.
2. **Nostr Agent Interface is the preferred operational interface** for mixed agentic workflows.
3. **CLI/API are first-class for automation, scripts, and service orchestration.**
4. **MCP is supported for MCP-native runtimes and clients that require protocol-level integration.**

## Interface Modes

| Mode | Best For | Command |
| --- | --- | --- |
| CLI | local shell agents, scripts, CI jobs | `nostr-agent-interface cli ...` |
| API | services, orchestrators, remote runtimes | `nostr-agent-interface api ...` |
| MCP | MCP-native clients (Claude Desktop/Cursor/Goose) | `nostr-agent-interface mcp` |

Compatibility binaries:

1. `nostr-agent-interface`
2. `nostr-mcp-server` (legacy alias retained)

## Quick Start

### CLI (recommended for local agent runs)

```bash
nostr-agent-interface cli list-tools --json
nostr-agent-interface cli getProfile --pubkey npub... --json
nostr-agent-interface cli convertNip19 --input npub... --target-type hex --json
```

Tool-specific help (derived from the canonical tool schema):

```bash
nostr-agent-interface cli getProfile --help
nostr-agent-interface cli postNote --help
```

MCP is intentionally separate from CLI/API so MCP-native tools can connect directly when needed:

```bash
nostr-agent-interface mcp
```

Legacy-compatible invocation style for CLI is still available:

```bash
nostr-agent-interface cli call getProfile '{"pubkey":"npub..."}' --json
```

Full CLI usage guide: `docs/cli.md`

### API (recommended for orchestration)

```bash
nostr-agent-interface api --host 127.0.0.1 --port 3030
```

```bash
curl -s http://127.0.0.1:3030/tools/getProfile \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"pubkey":"npub..."}'
```

Optional API auth:

```bash
NOSTR_AGENT_API_KEY=<api-key> nostr-agent-interface api --host 127.0.0.1 --port 3030

curl -s http://127.0.0.1:3030/tools \
  -H 'x-api-key: <api-key>'
```

Rate limiting:

1. `/tools` endpoints are rate-limited by default (in-memory fixed window).
2. Configure with `NOSTR_AGENT_API_RATE_LIMIT_MAX` and `NOSTR_AGENT_API_RATE_LIMIT_WINDOW_MS`.
3. Client identity defaults to socket IP unless API-key auth is valid for that request.
4. `NOSTR_AGENT_API_TRUST_PROXY=false` by default (recommended unless behind a trusted proxy).
5. Set `NOSTR_AGENT_API_RATE_LIMIT_MAX=0` to disable.

Request body limits:

1. Tool-call request bodies are capped by `NOSTR_AGENT_API_MAX_BODY_BYTES` (default `1048576` / 1 MiB).
2. Oversized payloads return `413` with `error.code = "payload_too_large"`.

Audit logging:

1. API emits structured JSON audit logs with `requestId` correlation.
2. Sensitive headers/body fields are redacted.
3. Configure with `NOSTR_AGENT_API_AUDIT_LOG_ENABLED` and `NOSTR_AGENT_API_AUDIT_LOG_INCLUDE_BODIES`.
4. For production defaults, see `docs/api.md` ("Production Defaults").

Endpoints:

1. `GET /health`
2. `GET /tools`
3. `POST /tools/:toolName`
4. `GET /v1/health`
5. `GET /v1/tools`
6. `POST /v1/tools/:toolName`

### MCP (explicit separate mode)

MCP is a separate, explicit compatibility mode. CLI and API execute tooling directly in-process and do not route through MCP.

```bash
nostr-agent-interface mcp
```

## Installation

### npm

```bash
npm install -g nostr-agent-interface
```

### Source (Bun)

```bash
git clone https://github.com/AustinKelsay/nostr-agent-interface.git
cd nostr-agent-interface
bun install
bun run build
```

### Source (npm)

```bash
git clone https://github.com/AustinKelsay/nostr-agent-interface.git
cd nostr-agent-interface
npm install
npm run build
```

## Tool Surface

This interface currently exposes **48 tools** across:

1. reading/querying
2. identity/profile
3. notes + generic events
4. social + relay list management
5. DMs (NIP-04 and NIP-44/NIP-17)
6. anonymous actions (note + zap)
7. NIP-19 conversion/analysis
8. Blossom storage

Canonical tool contracts live in `artifacts/tools.json`.

## Artifact Contract

`artifacts/tools.json` is the machine-readable contract for current tools and schemas. It now also carries interface lineage/transport metadata so downstream systems can distinguish:

1. canonical package identity (`nostr-agent-interface`)
2. project lineage (extension of Nostr MCP Server JARC contracts)
3. preferred operational model (CLI/API-first)
4. supported transports and preferred transports

Generate it with:

```bash
bun run build
# or
bun run generate:tools-manifest
```

## Configuration

Use `.env.example` as the baseline.

Precedence:

1. explicit CLI/API/tool arguments
2. environment variables
3. built-in defaults

Primary env vars:

1. `NOSTR_DEFAULT_RELAYS`
2. `NOSTR_AGENT_API_HOST`
3. `NOSTR_AGENT_API_PORT`
4. `NOSTR_AGENT_API_KEY` (optional; protects `/tools` endpoints)
5. `NOSTR_AGENT_API_RATE_LIMIT_MAX` (optional; default `120`)
6. `NOSTR_AGENT_API_RATE_LIMIT_WINDOW_MS` (optional; default `60000`)
7. `NOSTR_AGENT_API_AUDIT_LOG_ENABLED` (optional; default `true`)
8. `NOSTR_AGENT_API_AUDIT_LOG_INCLUDE_BODIES` (optional; default `true`)
9. `NOSTR_AGENT_API_TRUST_PROXY` (optional; default `false`)
10. `NOSTR_AGENT_API_MAX_BODY_BYTES` (optional; default `1048576`)
11. `NOSTR_MCP_COMMAND`
12. `NOSTR_MCP_ARGS`
13. `NOSTR_NETWORK_TESTS` (`1` to run network/integration suites that require ephemeral relays or port binding)
14. `NOSTR_JSON_ONLY` (`true` to suppress all CLI stderr logs and keep `--json` output machine-clean)

## MCP Client Setup (Optional)

If you use an MCP-native client, point it at the MCP mode entrypoint:

1. npm install: `npx nostr-agent-interface mcp`
2. source install: `node /ABSOLUTE/PATH/TO/nostr-agent-interface/build/app/index.js mcp`

Sample config file: `claude_desktop_config.sample.json`

## Documentation Map

1. `llm/README.md`
2. `llm/tool-catalog.md`
3. `llm/playbook.md`
4. `.agents/skills/nostr-agent-interface-cli/SKILL.md`
5. `docs/cli.md`
6. `docs/api.md`
7. `docs/testing.md`
8. `profile/README.md`
9. `note/README.md`
10. `zap/README.md`

## Development

```bash
bun run build
bun test
bun run test:parity
bun test __tests__/cli-core.test.ts __tests__/cli-ux.test.ts
bun test __tests__/api-core.test.ts __tests__/api-errors.test.ts __tests__/api-audit-logging.test.ts
bun test __tests__/mcp-dispatch.test.ts
bun test __tests__/zap-tools-tests.test.ts
bun run check:docs
NOSTR_NETWORK_TESTS=1 bun test
```

Detailed suite coverage and troubleshooting by surface: `docs/testing.md`.

## Lineage Summary

Nostr Agent Interface is an API/CLI-first extension of Nostr MCP Server. It preserves the original JARC tool contract and broadens how agents consume that contract without removing MCP support.
