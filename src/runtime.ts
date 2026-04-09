import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ContextEngine, OpenClawPluginApi, OpenClawPluginServiceContext } from "../api.js";
import type { TenantBridgePluginConfig } from "./config.js";
import {
  FileTenantBridgeStore,
  PostgresTenantBridgeStore,
  type TenantBridgeStore,
} from "./storage.js";
import type {
  AccessGrant,
  ArtifactInput,
  ContextDelta,
  MemoryRecord,
  PromotionRequest,
  RecallQuery,
  RecallResult,
  RecallSurface,
  StoredArtifact,
} from "./types.js";

type ArtifactBucket = {
  storeArtifacts(params: {
    delta: ContextDelta;
    recordId: string;
    artifacts: ArtifactInput[];
  }): Promise<StoredArtifact[]>;
};

type PendingDelta = {
  delta: ContextDelta;
};

type CreateTenantBridgeRuntimeParams = {
  api: OpenClawPluginApi;
  config: TenantBridgePluginConfig;
  store?: TenantBridgeStore;
};

type RuntimeServiceState = Pick<
  OpenClawPluginServiceContext,
  "stateDir" | "workspaceDir" | "logger"
>;

type ContextEngineMessage = Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]["messages"][number];

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n")
      .trim();
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content);
}

function readAgentMessageContent(message: ContextEngineMessage): unknown {
  return "content" in message ? message.content : undefined;
}

function inferDeltaKind(content: string): ContextDelta["kind"] {
  const normalized = content.toLowerCase();
  if (/^(todo|task|action item)\b/.test(normalized) || /\bnext step\b/.test(normalized)) {
    return "task";
  }
  if (/\b(decision|decided|we chose)\b/.test(normalized)) {
    return "decision";
  }
  if (/^(remember|preference|fact)\b/.test(normalized) || /\buser prefers\b/.test(normalized)) {
    return "fact";
  }
  return "message";
}

function resolveUserIdFromSessionKey(sessionKey?: string): string {
  const normalized = normalizeString(sessionKey);
  if (!normalized) {
    return "default-user";
  }
  const parts = normalized.split(":");
  if (parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  return normalized.replace(/[^a-z0-9._-]+/gi, "-");
}

function createOpenClawDelta(params: {
  config: TenantBridgePluginConfig;
  sessionId: string;
  sessionKey?: string;
  index: number;
  message: ContextEngineMessage;
}): ContextDelta | null {
  const content = messageContentToText(readAgentMessageContent(params.message));
  if (!content) {
    return null;
  }
  const timestamp =
    typeof params.message.timestamp === "number" && Number.isFinite(params.message.timestamp)
      ? new Date(params.message.timestamp).toISOString()
      : new Date().toISOString();
  const roleTag =
    typeof params.message.role === "string"
      ? `role:${params.message.role.toLowerCase()}`
      : undefined;
  return {
    tenantId: params.config.tenantId,
    userId: resolveUserIdFromSessionKey(params.sessionKey),
    appId: "openclaw",
    sessionId: params.sessionId,
    source: "openclaw.context-engine",
    timestamp,
    kind: inferDeltaKind(content),
    content,
    tags: [roleTag, "source:openclaw"].filter((value): value is string => Boolean(value)),
    idempotencyKey: `openclaw:${params.sessionId}:${params.index}:${hashContent(content)}`,
  };
}

function normalizeDeltaContent(delta: ContextDelta, includeTranscripts: boolean): string {
  const trimmed = delta.content.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (includeTranscripts || delta.kind !== "message") {
    return trimmed.slice(0, 8_000);
  }
  return trimmed.slice(0, 1_000);
}

function resolveSurfaceForDelta(delta: ContextDelta): RecallSurface {
  if (delta.kind === "fact" || delta.kind === "decision" || delta.kind === "task") {
    return "durable";
  }
  if (delta.kind === "artifact") {
    return "artifact";
  }
  return "episodic";
}

class LocalArtifactBucket implements ArtifactBucket {
  constructor(private readonly rootDir: string) {}

  async storeArtifacts(params: {
    delta: ContextDelta;
    recordId: string;
    artifacts: ArtifactInput[];
  }): Promise<StoredArtifact[]> {
    const storedArtifacts: StoredArtifact[] = [];
    for (const [index, artifact] of params.artifacts.entries()) {
      const artifactId = artifact.artifactId || randomUUID();
      let storageUrl: string | undefined;
      const hasInlineContent =
        typeof artifact.contentText === "string" || typeof artifact.contentBase64 === "string";
      if (hasInlineContent) {
        const dir = path.join(
          this.rootDir,
          params.delta.tenantId,
          params.delta.userId,
          params.recordId,
        );
        await fs.mkdir(dir, { recursive: true });
        const filename = `${String(index).padStart(2, "0")}-${artifactId}`;
        const filePath = path.join(dir, filename);
        const buffer =
          typeof artifact.contentBase64 === "string"
            ? Buffer.from(artifact.contentBase64, "base64")
            : Buffer.from(artifact.contentText ?? "", "utf8");
        await fs.writeFile(filePath, buffer);
        storageUrl = filePath;
      }
      storedArtifacts.push({
        artifactId,
        name: artifact.name,
        contentType: artifact.contentType,
        storageUrl,
        url: artifact.url,
        metadata: artifact.metadata,
      });
    }
    return storedArtifacts;
  }
}

class S3ArtifactBucket implements ArtifactBucket {
  constructor(
    private readonly params: {
      bucket: string;
      prefix?: string;
      endpoint?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    },
  ) {}

  async storeArtifacts(params: {
    delta: ContextDelta;
    recordId: string;
    artifacts: ArtifactInput[];
  }): Promise<StoredArtifact[]> {
    const moduleName = "@aws-sdk/client-s3";
    const imported = (await import(moduleName)) as {
      S3Client: new (config: Record<string, unknown>) => {
        send: (command: unknown) => Promise<unknown>;
      };
      PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    };
    const client = new imported.S3Client({
      endpoint: this.params.endpoint,
      region: this.params.region || "us-east-1",
      forcePathStyle: this.params.forcePathStyle,
      credentials:
        this.params.accessKeyId && this.params.secretAccessKey
          ? {
              accessKeyId: this.params.accessKeyId,
              secretAccessKey: this.params.secretAccessKey,
            }
          : undefined,
    });
    const storedArtifacts: StoredArtifact[] = [];
    for (const [index, artifact] of params.artifacts.entries()) {
      const artifactId = artifact.artifactId || randomUUID();
      const hasInlineContent =
        typeof artifact.contentText === "string" || typeof artifact.contentBase64 === "string";
      let storageUrl: string | undefined;
      if (hasInlineContent) {
        const key = [
          this.params.prefix?.replace(/^\/+|\/+$/g, ""),
          params.delta.tenantId,
          params.delta.userId,
          params.recordId,
          `${String(index).padStart(2, "0")}-${artifactId}`,
        ]
          .filter(Boolean)
          .join("/");
        const body =
          typeof artifact.contentBase64 === "string"
            ? Buffer.from(artifact.contentBase64, "base64")
            : Buffer.from(artifact.contentText ?? "", "utf8");
        await client.send(
          new imported.PutObjectCommand({
            Bucket: this.params.bucket,
            Key: key,
            Body: body,
            ContentType: artifact.contentType || "application/octet-stream",
          }),
        );
        storageUrl = `s3://${this.params.bucket}/${key}`;
      }
      storedArtifacts.push({
        artifactId,
        name: artifact.name,
        contentType: artifact.contentType,
        storageUrl,
        url: artifact.url,
        metadata: artifact.metadata,
      });
    }
    return storedArtifacts;
  }
}

export type TenantBridgeRuntime = ReturnType<typeof createTenantBridgeRuntime>;

export function createTenantBridgeRuntime(params: CreateTenantBridgeRuntimeParams) {
  const pending: PendingDelta[] = [];
  let serviceState: RuntimeServiceState | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let storePromise: Promise<TenantBridgeStore> | undefined;
  let artifactBucketPromise: Promise<ArtifactBucket> | undefined;
  let materializationDirty = false;
  let flushInFlight: Promise<void> | undefined;
  let warnedDbFallback = false;
  let warnedS3Fallback = false;

  async function ensureStore(): Promise<TenantBridgeStore> {
    if (params.store) {
      return params.store;
    }
    if (!storePromise) {
      storePromise = (async () => {
        const stateRoot = path.join(
          serviceState?.stateDir ?? params.api.resolvePath(".tenant-bridge"),
          "tenant-bridge",
        );
        const databaseUrl = normalizeString(params.config.storage.databaseUrl);
        if (databaseUrl && /^(postgres|postgresql):/i.test(databaseUrl)) {
          try {
            const moduleName = "pg";
            const imported = (await import(moduleName)) as {
              Pool: new (config: { connectionString: string }) => unknown;
            };
            const pool = new imported.Pool({ connectionString: databaseUrl }) as {
              query: (
                text: string,
                params?: readonly unknown[],
              ) => Promise<{ rows: Record<string, unknown>[] }>;
              end?: () => Promise<void>;
            };
            return new PostgresTenantBridgeStore(pool);
          } catch (error) {
            if (!warnedDbFallback) {
              warnedDbFallback = true;
              params.api.logger.warn(
                `[tenant-bridge] falling back to file store because Postgres support is unavailable: ${String(error)}`,
              );
            }
          }
        }
        return new FileTenantBridgeStore(path.join(stateRoot, "state.json"));
      })();
    }
    return await storePromise;
  }

  async function ensureArtifactBucket(): Promise<ArtifactBucket> {
    if (!artifactBucketPromise) {
      artifactBucketPromise = (async () => {
        const bucket = normalizeString(params.config.storage.bucket);
        const s3Config = params.config.storage.s3;
        if (bucket && s3Config?.endpoint) {
          try {
            const moduleName = "@aws-sdk/client-s3";
            await import(moduleName);
            return new S3ArtifactBucket({
              bucket,
              endpoint: s3Config.endpoint,
              region: s3Config.region,
              accessKeyId: s3Config.accessKeyId,
              secretAccessKey: s3Config.secretAccessKey,
              forcePathStyle: s3Config.forcePathStyle,
              prefix: s3Config.prefix,
            });
          } catch (error) {
            if (!warnedS3Fallback) {
              warnedS3Fallback = true;
              params.api.logger.warn(
                `[tenant-bridge] falling back to local artifacts because S3 support is unavailable: ${String(error)}`,
              );
            }
          }
        }
        const rootDir = bucket
          ? params.api.resolvePath(bucket)
          : path.join(
              serviceState?.stateDir ?? params.api.resolvePath(".tenant-bridge"),
              "artifacts",
            );
        return new LocalArtifactBucket(rootDir);
      })();
    }
    return await artifactBucketPromise;
  }

  async function materializeQmd(): Promise<void> {
    if (!params.config.sync.materializeQmd) {
      materializationDirty = false;
      return;
    }
    const store = await ensureStore();
    const records = await store.listRecords({
      tenantId: params.config.tenantId,
      surfaces: ["durable"],
    });
    const targetBase =
      serviceState?.workspaceDir ?? serviceState?.stateDir ?? params.api.resolvePath(".");
    const targetDir = path.join(targetBase, params.config.sync.qmdRelativeDir);
    await fs.mkdir(targetDir, { recursive: true });
    const recordsByUser = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      recordsByUser.set(record.userId, [...(recordsByUser.get(record.userId) ?? []), record]);
    }
    for (const [userId, userRecords] of recordsByUser) {
      const filePath = path.join(targetDir, `${userId}.md`);
      const lines = [`# Shared Memory for ${userId}`, ""];
      for (const record of userRecords.toSorted(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )) {
        lines.push(`## ${record.kind} · ${record.updatedAt}`);
        lines.push(`- app: ${record.appId}`);
        lines.push(`- session: ${record.sessionId}`);
        if (record.tags.length > 0) {
          lines.push(`- tags: ${record.tags.join(", ")}`);
        }
        lines.push("");
        lines.push(record.content);
        lines.push("");
      }
      await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    }
    materializationDirty = false;
  }

  async function persistDelta(delta: ContextDelta): Promise<MemoryRecord | null> {
    const store = await ensureStore();
    const existing = await store.getRecordByIdempotency({
      tenantId: delta.tenantId,
      idempotencyKey: delta.idempotencyKey,
    });
    if (existing) {
      return existing;
    }
    const content = normalizeDeltaContent(delta, params.config.sync.includeTranscripts);
    if (!content) {
      return null;
    }
    const recordId = randomUUID();
    const artifacts = delta.artifacts?.length
      ? await (
          await ensureArtifactBucket()
        ).storeArtifacts({
          delta,
          recordId,
          artifacts: delta.artifacts,
        })
      : [];
    const nowIso = new Date().toISOString();
    const surface = resolveSurfaceForDelta(delta);
    const record: MemoryRecord = {
      recordId,
      tenantId: delta.tenantId,
      userId: delta.userId,
      appId: delta.appId,
      sessionId: delta.sessionId,
      source: delta.source,
      kind: delta.kind,
      surface,
      content,
      tags: [...new Set(delta.tags ?? [])],
      idempotencyKey: delta.idempotencyKey,
      artifacts,
      createdAt: delta.timestamp || nowIso,
      updatedAt: nowIso,
      expiresAt:
        surface === "episodic" || surface === "artifact"
          ? new Date(Date.now() + params.config.sync.artifactTtlMs).toISOString()
          : undefined,
    };
    await store.saveRecord(record);
    materializationDirty = true;
    return record;
  }

  async function flushInternal(): Promise<void> {
    if (flushInFlight) {
      return await flushInFlight;
    }
    flushInFlight = (async () => {
      while (pending.length > 0) {
        const next = pending.shift();
        if (!next) {
          break;
        }
        try {
          await persistDelta(next.delta);
        } catch (error) {
          params.api.logger.warn(`[tenant-bridge] failed to persist delta: ${String(error)}`);
        }
      }
      flushInFlight = undefined;
    })();
    return await flushInFlight;
  }

  async function maintenanceTick(): Promise<void> {
    await flushInternal();
    const store = await ensureStore();
    await store.cleanup({ now: new Date() });
    if (materializationDirty) {
      await materializeQmd();
    }
  }

  function scheduleTimers(): void {
    if (!flushTimer) {
      flushTimer = setInterval(() => {
        void flushInternal();
      }, params.config.sync.flushIntervalMs);
    }
    if (!maintenanceTimer) {
      maintenanceTimer = setInterval(() => {
        void maintenanceTick();
      }, params.config.sync.maintenanceIntervalMs);
    }
  }

  function clearTimers(): void {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
    }
  }

  async function retrieveInternal(query: RecallQuery): Promise<RecallResult> {
    await flushInternal();
    const store = await ensureStore();
    const cappedQuery: RecallQuery = {
      ...query,
      limit: Math.min(
        query.limit ?? params.config.recall.defaultLimit,
        params.config.recall.maxResults,
      ),
      surfaces: query.surfaces?.length ? query.surfaces : params.config.recall.defaultSurfaces,
    };
    return await store.retrieve(cappedQuery);
  }

  return {
    config: params.config,
    async start(context: OpenClawPluginServiceContext): Promise<void> {
      serviceState = {
        stateDir: context.stateDir,
        workspaceDir: context.workspaceDir,
        logger: context.logger,
      };
      scheduleTimers();
      await ensureStore();
      params.api.logger.info(`[tenant-bridge] started for tenant ${params.config.tenantId}`);
    },
    async stop(): Promise<void> {
      clearTimers();
      await flushInternal();
      const store = await ensureStore();
      await store.close();
      params.api.logger.info(`[tenant-bridge] stopped for tenant ${params.config.tenantId}`);
    },
    async flush(): Promise<void> {
      await flushInternal();
    },
    async enqueueDelta(delta: ContextDelta): Promise<void> {
      pending.push({ delta });
    },
    async ingestOpenClawMessages(input: {
      sessionId: string;
      sessionKey?: string;
      messages: ContextEngineMessage[];
      prePromptMessageCount: number;
      autoCompactionSummary?: string;
      isHeartbeat?: boolean;
    }): Promise<void> {
      if (input.isHeartbeat) {
        return;
      }
      const newMessages = input.messages.slice(input.prePromptMessageCount);
      for (const [index, message] of newMessages.entries()) {
        const delta = createOpenClawDelta({
          config: params.config,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          index: input.prePromptMessageCount + index,
          message,
        });
        if (delta) {
          pending.push({ delta });
        }
      }
      const summary = normalizeString(input.autoCompactionSummary);
      if (summary) {
        pending.push({
          delta: {
            tenantId: params.config.tenantId,
            userId: resolveUserIdFromSessionKey(input.sessionKey),
            appId: "openclaw",
            sessionId: input.sessionId,
            source: "openclaw.context-engine",
            timestamp: new Date().toISOString(),
            kind: "summary",
            content: summary,
            tags: ["source:openclaw", "kind:summary"],
            idempotencyKey: `openclaw:${input.sessionId}:summary:${hashContent(summary)}`,
          },
        });
      }
    },
    async retrieve(query: RecallQuery): Promise<RecallResult> {
      return await retrieveInternal(query);
    },
    async upsertAccessGrant(grant: AccessGrant): Promise<AccessGrant> {
      const store = await ensureStore();
      const nextGrant: AccessGrant = {
        ...grant,
        grantId: grant.grantId || randomUUID(),
        tenantId: params.config.tenantId,
        surfaces: grant.surfaces,
        createdAt: grant.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return await store.upsertAccessGrant(nextGrant);
    },
    async promoteRecords(request: PromotionRequest): Promise<MemoryRecord[]> {
      await flushInternal();
      const store = await ensureStore();
      const promoted = await store.promoteRecords({
        tenantId: request.tenantId,
        userId: request.userId,
        recordIds: request.recordIds,
      });
      if (promoted.length > 0) {
        materializationDirty = true;
      }
      return promoted;
    },
    async buildRecallMessage(params: {
      query: RecallQuery;
      limit?: number;
    }): Promise<{ message?: ContextEngineMessage; promptSummary?: string; result: RecallResult }> {
      const result = await retrieveInternal({
        ...params.query,
        limit: params.limit ?? params.query.limit,
      });
      if (result.results.length === 0) {
        return { result };
      }
      const lines = ["Relevant shared recall from approved apps:"];
      for (const record of result.results.slice(0, params.limit ?? 4)) {
        lines.push(`- [${record.surface}] ${record.content}`);
      }
      return {
        result,
        message: {
          role: "user",
          content: lines.join("\n"),
          timestamp: Date.now(),
        } as ContextEngineMessage,
        promptSummary: lines.join("\n"),
      };
    },
    resolveUserIdFromSessionKey,
    inferDeltaKind,
    messageContentToText,
  };
}
