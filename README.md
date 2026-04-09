# OpenClaw Tenant Bridge

Shared memory for OpenClaw across tenants, users, and external agents.

`@abdullah4ai/openclaw-tenant-bridge` is an OpenClaw plugin that adds a custom
context engine, authenticated bridge routes, a rewrite layer, and
permission-filtered retrieval. It lets OpenClaw exchange curated memory with
apps like Codex, ChatGPT, and Claude Code without modifying OpenClaw core.

![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-0f172a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square)
![ClawHub](https://img.shields.io/badge/ClawHub-Community-f97316?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-16a34a?style=flat-square)

```bash
$ openclaw plugins install @abdullah4ai/openclaw-tenant-bridge

> tenant: acme-prod
> app: codex
> delta accepted
> memory promoted
> authorized recall injected into the next OpenClaw run
```

## Why it exists

OpenClaw is strong at agent execution and local context handling. This plugin
adds the missing shared-memory bridge around it:

- Multi-tenancy layer
- Multi-user layer
- Agent context data bridge
- Context and memory rewrite layer
- Storage and artifact layer
- Memory retrieval layer
- Permissions control layer

The result is a plugin-backed service that keeps OpenClaw as the runtime while
making cross-app memory practical and safe.

## Install

### Install from ClawHub

```bash
openclaw plugins install @abdullah4ai/openclaw-tenant-bridge
```

Restart your OpenClaw gateway after installation.

### Install from a local checkout

```bash
git clone https://github.com/Abdullah4AI/openclaw-tenant-bridge.git
cd openclaw-tenant-bridge
corepack pnpm install
openclaw plugins install -l /absolute/path/to/openclaw-tenant-bridge
```

When using `-l`, OpenClaw links the source directory directly, so the plugin
repo needs its own `node_modules`.

## What it provides

| Capability | What it does |
| --- | --- |
| Context engine | Registers `tenant-bridge` through `api.registerContextEngine(...)` |
| Bridge API | Exposes authenticated routes at `/plugins/tenant-bridge/v1` |
| Rewrite layer | Normalizes incoming deltas before storage |
| Retrieval layer | Returns only authorized memory records |
| Permission model | Enforces tenant and user boundaries with explicit grants |
| Storage | Uses local files by default, with optional Postgres and S3-compatible storage |
| Background sync | Flushes queued deltas, promotes records, and handles artifact maintenance |
| Optional QMD export | Materializes durable shared memory as markdown for QMD-style indexing |

## Architecture

The plugin implements the sketch as a plugin-backed boundary instead of an
OpenClaw core fork:

```text
Multi-tenant deployment boundary
  -> one OpenClaw gateway per tenant

Multi-user boundary inside the gateway
  -> one userId-scoped memory space per user

Agents
  -> OpenClaw sessions write through the tenant-bridge context engine

Context data bridge
  -> /context-deltas, /retrieve, /memory/promote, /access-grants

Rewrite layer
  -> normalize, classify, and score deltas before persistence

Storage layer
  -> local files by default, optional Postgres + S3-compatible artifacts

Retrieve layer
  -> recall by tenant, user, app, surfaces, and query

Permissions layer
  -> same-user access by default, cross-user access only through grants
```

## Security model

- Tenant isolation is enforced by `tenantId` checks on every bridge request.
- User memories are scoped by `userId`.
- Cross-user retrieval is blocked unless an active `AccessGrant` exists.
- Apps must be allowlisted with `bridge.allowedApps`.
- Each app must present its configured service token.
- Tokens are accepted through `Authorization: Bearer ...` or
  `x-tenant-bridge-token`.

Recommended deployment model:

- One OpenClaw gateway per tenant
- One OpenClaw agent per human user
- Separate `workspace` and `agentDir` per user
- `session.dmScope = "per-channel-peer"`

## Memory model

The plugin works with three recall surfaces:

| Surface | Purpose |
| --- | --- |
| `episodic` | Recent interaction memory |
| `durable` | Promoted long-lived facts, decisions, and tasks |
| `artifact` | Stored files, URLs, or generated content attachments |

Supported delta kinds:

- `message`
- `decision`
- `task`
- `fact`
- `summary`
- `artifact`

## Quick start

Enable the plugin and set it as the active context engine:

```json5
{
  plugins: {
    slots: {
      contextEngine: "tenant-bridge"
    },
    entries: {
      "tenant-bridge": {
        enabled: true,
        config: {
          tenantId: "tenant-acme",
          bridge: {
            allowedApps: ["openclaw", "codex", "chatgpt", "claude-code"],
            serviceTokens: {
              codex: "replace-me-with-a-real-token"
            }
          },
          recall: {
            defaultSurfaces: ["durable", "episodic"],
            defaultLimit: 8,
            maxResults: 20,
            includeSystemPromptSummary: true
          },
          sync: {
            materializeQmd: false,
            includeTranscripts: false
          }
        }
      }
    }
  }
}
```

If `storage.databaseUrl` is omitted, the plugin falls back to local file-backed
state. If `storage.bucket` is set, artifacts can be stored in a local path or
an S3-compatible bucket, depending on the rest of `storage.s3`.

## Bridge routes

The plugin registers these routes:

- `POST /plugins/tenant-bridge/v1/context-deltas`
- `POST /plugins/tenant-bridge/v1/retrieve`
- `POST /plugins/tenant-bridge/v1/memory/promote`
- `POST /plugins/tenant-bridge/v1/access-grants`

## Example: write memory into the bridge

```bash
curl -X POST http://localhost:3000/plugins/tenant-bridge/v1/context-deltas \
  -H 'Authorization: Bearer replace-me-with-a-real-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "tenant-acme",
    "userId": "user-42",
    "appId": "codex",
    "sessionId": "session-abc",
    "timestamp": "2026-04-09T20:00:00.000Z",
    "kind": "fact",
    "content": "The ACME sandbox uses project greenfield by default.",
    "tags": ["sandbox", "default-project"],
    "idempotencyKey": "codex-session-abc-fact-1"
  }'
```

## Example: retrieve authorized recall

```bash
curl -X POST http://localhost:3000/plugins/tenant-bridge/v1/retrieve \
  -H 'Authorization: Bearer replace-me-with-a-real-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "tenant-acme",
    "userId": "user-42",
    "appId": "codex",
    "sessionId": "session-abc",
    "query": "What sandbox project should I use?",
    "surfaces": ["durable", "episodic"],
    "limit": 5
  }'
```

## Example: grant cross-user access

```bash
curl -X POST http://localhost:3000/plugins/tenant-bridge/v1/access-grants \
  -H 'Authorization: Bearer replace-me-with-a-real-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "tenant-acme",
    "appId": "codex",
    "grant": {
      "ownerUserId": "user-admin",
      "targetUserId": "user-42",
      "surfaces": ["durable"],
      "note": "Share approved durable tenant setup notes"
    }
  }'
```

## Storage modes

| Mode | Metadata | Artifacts |
| --- | --- | --- |
| Local only | Local file-backed store | Local filesystem |
| Database-backed | Postgres | Local filesystem |
| Full externalized | Postgres | S3-compatible storage |

Optional sync features:

- `sync.materializeQmd`
- `sync.includeTranscripts`
- `sync.flushIntervalMs`
- `sync.maintenanceIntervalMs`
- `sync.artifactTtlMs`
- `sync.qmdRelativeDir`

## Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm audit
```

## Verification

The current repo verifies:

- tenant isolation
- permission enforcement
- rewrite behavior
- storage and retrieval
- an end-to-end OpenClaw to bridge recall path

## Repository files

- Plugin entry: [index.ts](./index.ts)
- Runtime: [src/runtime.ts](./src/runtime.ts)
- Context engine: [src/context-engine.ts](./src/context-engine.ts)
- HTTP bridge: [src/http.ts](./src/http.ts)
- Storage: [src/storage.ts](./src/storage.ts)
- Security policy: [SECURITY.md](./SECURITY.md)

## License

MIT. See [LICENSE](./LICENSE).
