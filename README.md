# OpenClaw Tenant Bridge

`@abdullah4ai/openclaw-tenant-bridge` is a plugin-first shared-memory bridge for OpenClaw.
It adds a custom context engine plus authenticated HTTP endpoints so external
apps such as Codex or Claude Code can write curated memory deltas and retrieve
permission-filtered recall.

## Install for local `-l` usage

Clone this repository, install dependencies, then link it into your OpenClaw
gateway:

```bash
git clone <your-repo-url> openclaw-tenant-bridge
cd openclaw-tenant-bridge
corepack pnpm install

openclaw plugins install -l /absolute/path/to/openclaw-tenant-bridge
```

Restart the gateway after linking.

Because `--link` reuses the source path, this repository must keep its own
`node_modules` directory. Run `corepack pnpm install` in the plugin repo before
starting OpenClaw.

## Install from ClawHub

After publishing, users can install it directly with:

```bash
openclaw plugins install @abdullah4ai/openclaw-tenant-bridge
```

## What it provides

- `tenant-bridge` context engine via `api.registerContextEngine(...)`
- HTTP bridge routes under `/plugins/tenant-bridge/v1`
- Service-token auth per external app id
- Local-file or Postgres-backed metadata storage
- Optional S3-compatible artifact storage
- Optional markdown/QMD materialization for shared durable memory

## Minimal config

Set plugin config under `plugins.entries.tenant-bridge.config`:

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
            allowedApps: ["codex"],
            serviceTokens: {
              codex: "replace-me"
            }
          },
          recall: {
            defaultSurfaces: ["episodic", "durable", "artifact"]
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

## HTTP routes

- `POST /plugins/tenant-bridge/v1/context-deltas`
- `POST /plugins/tenant-bridge/v1/retrieve`
- `POST /plugins/tenant-bridge/v1/memory/promote`
- `POST /plugins/tenant-bridge/v1/access-grants`

## Local development

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
```
