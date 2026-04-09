import { z } from "zod";
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "../api.js";
import type { RecallSurface } from "./types.js";

const recallSurfaceSchema = z.enum(["episodic", "durable", "artifact"]);
const defaultAllowedApps = ["openclaw", "codex", "chatgpt", "claude-code"];
const defaultRecallSurfaces: RecallSurface[] = ["durable", "episodic"];

export type TenantBridgePluginConfig = {
  tenantId: string;
  storage: {
    databaseUrl?: string;
    bucket?: string;
    s3?: {
      endpoint?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
      prefix?: string;
    };
  };
  bridge: {
    allowedApps: string[];
    serviceTokens: Record<string, string>;
  };
  recall: {
    defaultSurfaces: RecallSurface[];
    defaultLimit: number;
    maxResults: number;
    includeSystemPromptSummary: boolean;
  };
  sync: {
    materializeQmd: boolean;
    includeTranscripts: boolean;
    flushIntervalMs: number;
    maintenanceIntervalMs: number;
    artifactTtlMs: number;
    qmdRelativeDir: string;
  };
};

const defaultTenantBridgePluginConfig: TenantBridgePluginConfig = {
  tenantId: "default-tenant",
  storage: {},
  bridge: {
    allowedApps: [...defaultAllowedApps],
    serviceTokens: {},
  },
  recall: {
    defaultSurfaces: [...defaultRecallSurfaces],
    defaultLimit: 8,
    maxResults: 20,
    includeSystemPromptSummary: true,
  },
  sync: {
    materializeQmd: false,
    includeTranscripts: false,
    flushIntervalMs: 1_000,
    maintenanceIntervalMs: 15_000,
    artifactTtlMs: 7 * 24 * 60 * 60 * 1_000,
    qmdRelativeDir: ".tenant-bridge/qmd",
  },
};

const runtimeConfigSchema = z.object({
  tenantId: z.string().trim().min(1).optional(),
  storage: z
    .object({
      databaseUrl: z.string().trim().min(1).optional(),
      bucket: z.string().trim().min(1).optional(),
      s3: z
        .object({
          endpoint: z.string().trim().min(1).optional(),
          region: z.string().trim().min(1).optional(),
          accessKeyId: z.string().trim().min(1).optional(),
          secretAccessKey: z.string().trim().min(1).optional(),
          forcePathStyle: z.boolean().optional(),
          prefix: z.string().trim().optional(),
        })
        .optional(),
    })
    .optional(),
  bridge: z
    .object({
      allowedApps: z.array(z.string().trim().min(1)).optional(),
      serviceTokens: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  recall: z
    .object({
      defaultSurfaces: z.array(recallSurfaceSchema).optional(),
      defaultLimit: z.number().int().min(1).max(50).optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
      includeSystemPromptSummary: z.boolean().optional(),
    })
    .optional(),
  sync: z
    .object({
      materializeQmd: z.boolean().optional(),
      includeTranscripts: z.boolean().optional(),
      flushIntervalMs: z.number().int().min(100).optional(),
      maintenanceIntervalMs: z.number().int().min(1_000).optional(),
      artifactTtlMs: z.number().int().min(1_000).optional(),
      qmdRelativeDir: z.string().trim().optional(),
    })
    .optional(),
});
type ParsedTenantBridgePluginConfig = z.infer<typeof runtimeConfigSchema>;

const tenantBridgePluginConfigUiHints = {
  tenantId: {
    label: "Tenant ID",
    help: "Stable tenant identifier for this gateway instance.",
  },
  "storage.databaseUrl": {
    label: "Database URL",
    help: "Postgres connection string. When omitted, the plugin falls back to local file-backed state.",
  },
  "storage.bucket": {
    label: "Artifact Bucket",
    help: "S3 bucket name or local artifact directory path for stored bridge artifacts.",
  },
  "bridge.allowedApps": {
    label: "Allowed Apps",
    help: "External app ids allowed to use the bridge HTTP API.",
  },
  "bridge.serviceTokens": {
    label: "Service Tokens",
    help: "Map of app id to bearer token for plugin HTTP access.",
  },
  "recall.defaultSurfaces": {
    label: "Default Recall Surfaces",
    help: "Default memory surfaces used when callers omit surfaces in retrieve requests.",
  },
  "sync.materializeQmd": {
    label: "Materialize Markdown",
    help: "Write durable shared memory snapshots into markdown files for optional QMD indexing.",
  },
  "sync.includeTranscripts": {
    label: "Include Transcripts",
    help: "Persist raw message-style deltas from bridge callers instead of only curated records.",
  },
};

export const tenantBridgePluginConfigSchema: OpenClawPluginConfigSchema = {
  ...buildPluginConfigSchema(runtimeConfigSchema),
  uiHints: tenantBridgePluginConfigUiHints,
};

export function resolveTenantBridgePluginConfig(
  input: Record<string, unknown> | undefined,
): TenantBridgePluginConfig {
  const parsed: ParsedTenantBridgePluginConfig = runtimeConfigSchema.parse(input ?? {});
  return {
    tenantId: parsed.tenantId || defaultTenantBridgePluginConfig.tenantId,
    storage: {
      databaseUrl: parsed.storage?.databaseUrl,
      bucket: parsed.storage?.bucket,
      s3: parsed.storage?.s3,
    },
    bridge: {
      allowedApps:
        parsed.bridge?.allowedApps && parsed.bridge.allowedApps.length > 0
          ? parsed.bridge.allowedApps
          : [...defaultTenantBridgePluginConfig.bridge.allowedApps],
      serviceTokens: parsed.bridge?.serviceTokens ?? {},
    },
    recall: {
      defaultSurfaces:
        parsed.recall?.defaultSurfaces && parsed.recall.defaultSurfaces.length > 0
          ? (parsed.recall.defaultSurfaces as RecallSurface[])
          : [...defaultTenantBridgePluginConfig.recall.defaultSurfaces],
      defaultLimit:
        parsed.recall?.defaultLimit ?? defaultTenantBridgePluginConfig.recall.defaultLimit,
      maxResults: parsed.recall?.maxResults ?? defaultTenantBridgePluginConfig.recall.maxResults,
      includeSystemPromptSummary:
        parsed.recall?.includeSystemPromptSummary ??
        defaultTenantBridgePluginConfig.recall.includeSystemPromptSummary,
    },
    sync: {
      materializeQmd:
        parsed.sync?.materializeQmd ?? defaultTenantBridgePluginConfig.sync.materializeQmd,
      includeTranscripts:
        parsed.sync?.includeTranscripts ?? defaultTenantBridgePluginConfig.sync.includeTranscripts,
      flushIntervalMs:
        parsed.sync?.flushIntervalMs ?? defaultTenantBridgePluginConfig.sync.flushIntervalMs,
      maintenanceIntervalMs:
        parsed.sync?.maintenanceIntervalMs ??
        defaultTenantBridgePluginConfig.sync.maintenanceIntervalMs,
      artifactTtlMs:
        parsed.sync?.artifactTtlMs ?? defaultTenantBridgePluginConfig.sync.artifactTtlMs,
      qmdRelativeDir:
        parsed.sync?.qmdRelativeDir ?? defaultTenantBridgePluginConfig.sync.qmdRelativeDir,
    },
  };
}
