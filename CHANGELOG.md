# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.0] - 2026-04-04

### Changed
- Reframed project documentation around Nostr Agent Interface as an extension of Nostr MCP Server's JARC tool contracts, with CLI/API as preferred operational interfaces and MCP retained as supported compatibility mode.
- Updated release/process/docs guidance and package metadata links to point to `nostr-agent-interface` repository coordinates.
- Expanded testing documentation with suite-level coverage mapping for CLI command parsing, API request lifecycle and sanitization, MCP dispatch/schema stability, and zap-processing edge coverage.

### Added
- Added lineage and transport metadata to generated `artifacts/tools.json` so downstream consumers can identify interface intent, CLI/API-first preference, and MCP compatibility posture.
- Added optional API-key protection for HTTP tool endpoints via `NOSTR_AGENT_API_KEY` (`x-api-key` or `Authorization: Bearer`), while keeping `GET /health` publicly accessible for probes.
- Added configurable in-memory rate limiting for API tool endpoints via `NOSTR_AGENT_API_RATE_LIMIT_MAX` and `NOSTR_AGENT_API_RATE_LIMIT_WINDOW_MS`, including standardized `429 rate_limited` responses and rate-limit headers.
- Added structured API audit logging with request/response events, sensitive-field redaction, and `x-request-id` correlation controls (`NOSTR_AGENT_API_AUDIT_LOG_ENABLED`, `NOSTR_AGENT_API_AUDIT_LOG_INCLUDE_BODIES`).
- Added `/v1` API route compatibility layer (`/v1/health`, `/v1/tools`, `/v1/tools/:toolName`) while preserving existing route support.
- Added dedicated regression suites for in-process CLI command parsing (`cli-core`), API in-memory request lifecycle and sanitization (`api-core`), and full MCP dispatch/schema stability (`mcp-dispatch`), plus expanded zap-processing edge coverage.
- Added Blossom storage tooling across CLI/API/MCP surfaces: `getBlossomServers`, `setBlossomServers`, `getBlossomUrl`, `uploadBlob`, `downloadBlob`, `listBlobs`, `deleteBlob`, and `mirrorBlob`.
- Added repo-local Codex skill documentation for safe `nostr-agent-interface cli` usage and refreshed model-facing docs to match the 48-tool surface.

### Fixed
- Updated `snstr` to `v0.3.2`, picking up the websocket cleanup and exit-code fix included after `3.0.0`.


## [3.0.0] - 2026-02-13

### Added
- Added generic event tooling (`queryEvents`, `createNostrEvent`, `signNostrEvent`, `publishNostrEvent`)
- Added social tooling for follow/unfollow, reactions, reposts, deletions, and threaded replies
- Added relay list tooling for NIP-65 (`getRelayList`, `setRelayList`) with optional NIP-42 relay authentication
- Added direct message tooling for NIP-04 and NIP-44/NIP-17 workflows, including encrypt/decrypt, send, inbox, and conversation retrieval
- Added `since`/`until` pagination support for event queries
- Added dedicated test suites for event tools, social tools, relay tools, DM tools, and NIP-42 auth flows

### Changed
- Updated `snstr` dependency to `v0.3.1`
- Unified private-key normalization and signing helpers across note/event/social/relay/DM flows
- Centralized shared constants and query timeout usage in DM/relay/social tools and related tests

### Fixed
- Improved deterministic latest-event selection and shared contact/relay list formatting
- Fixed relay and DM auth error handling; DM handlers now correctly forward `authPrivateKey`
- Hardened relay auth key handling in NIP-42 flows

### Removed
- Removed an accidentally tracked local Claude Desktop config file from the repository history

## [2.1.0] - 2026-01-08

### Added
- Added `.npmignore` to control published npm package contents

### Changed
- Migrated test runner from Jest to Bun's native test runner for faster test execution
- Simplified build scripts using native shell commands
- Updated release scripts to use Bun (`bun test && bun run build`)
- Updated GitHub release workflow to align with Bun-based release CI
- Updated npm package metadata/docs, including npm badge updates in README
- Published the package updates to npm

### Removed
- NIPs search functionality (`searchNips` tool) - simplifies the server by removing external GitHub API dependencies
- `node-fetch` dependency (Bun has built-in fetch support)
- Jest configuration and dependencies (`jest.config.cjs`, `jest.setup.js`, `tsconfig.jest.json`)

## [2.0.0] - 2025-08-05

### Added
- NIP-19 entity conversion tools (`convertNip19` and `analyzeNip19`)
- Comprehensive test suite with 14 test files covering all tools
- Profile management tools for creating and updating Nostr profiles
- Authenticated note posting with existing private keys
- Anonymous note and zap functionality
- Long-form content support (NIP-23, kind 30023)
- Zap validation and direction detection (sent/received/self)
- NIPs search functionality with relevance scoring
- Support for all major NIP-19 entity types (npub, nsec, note, nevent, nprofile, naddr)

### Changed
- Migrated from nostr-tools and NDK to snstr library for core Nostr functionality
- Improved error handling to prevent JSON response interference in MCP
- Enhanced zap processing with better BOLT11 invoice parsing
- Updated relay pool management for better connection handling

### Fixed
- Fixed extractHexFromEntity returning incorrect data types for nevent entities
- Removed console.log/console.error statements that interfered with MCP JSON responses
- Fixed TypeScript type definitions replacing `any` types with proper interfaces
- Corrected test expectations to match actual API behavior

## [1.0.0] - Initial Release

### Added
- Basic Nostr MCP server implementation
- 16 core tools for interacting with Nostr network
- Profile fetching and note reading functionality
- Zap receipt processing
- Basic anonymous operations
- Default relay configuration
- Claude Desktop integration support
