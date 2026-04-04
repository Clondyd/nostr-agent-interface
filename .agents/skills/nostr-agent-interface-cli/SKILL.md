---
name: nostr-agent-interface-cli
description: Use when an agent needs to inspect, discover, or invoke Nostr Agent Interface CLI tools through `nostr-agent-interface cli`. Prefer this skill for local CLI-first Nostr workflows, schema-aware tool discovery, safe secret handling, and read-before-write execution.
---

# Nostr Agent Interface CLI

Use this skill when the user wants to work through `nostr-agent-interface cli` instead of MCP or HTTP API.

## Command Prefix

Use this canonical prefix:

```bash
nostr-agent-interface cli
```

If that binary is unavailable and you are clearly inside this repository with built artifacts present, fall back to:

```bash
node build/app/index.js cli
```

Do not assume source `.ts` entrypoints are directly runnable under `node`.

## Discovery Flow

1. Start with:

```bash
nostr-agent-interface cli list-tools --json
```

2. Inspect a specific tool before using it when the shape is not already clear:

```bash
nostr-agent-interface cli <toolName> --help
```

Treat live CLI help and `artifacts/tools.json` as authoritative when prose docs drift.

## Invocation Rules

1. Prefer schema-aware flags for simple non-secret args.
2. Prefer `--stdin --json` for secrets, nested objects, or larger payloads.
3. Prefer `--json` for machine parsing.
4. Prefer `NOSTR_JSON_ONLY=true` together with `--json` when stderr noise could break parsing.
5. Do not mix input modes in one command.

## Safety Rules

1. Never pass secrets in argv when `--stdin` can be used.
2. Never expose raw private keys in user-facing summaries unless the user explicitly asks for key material.
3. Normalize ambiguous keys or entities with `analyzeNip19` or `convertNip19` before mutating.
4. Use read-first workflows before writes.
5. Routine writes may proceed when the user request is explicit.
6. Ask for extra confirmation before destructive or account-shaping actions such as `deleteEvent`, `deleteBlob`, `unfollow`, `setRelayList`, or `setBlossomServers`.

## Error Policy

1. Re-check `list-tools --json` or `<toolName> --help`.
2. Retry once with explicit relays when that is a plausible fix.
3. Return the exact tool error together with a sanitized argument summary.

## References

Read only what you need:

1. `references/cli-essentials.md` for command forms, JSON/stdin usage, fallback execution, and secret handling.
2. `references/tool-groups.md` for the current tool surface by intent.
3. `references/workflows.md` for short end-to-end command templates.
