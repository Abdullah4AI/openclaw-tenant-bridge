import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { PluginLogger } from "../api.js";
import { authorizeAppRequest } from "./auth.js";
import type { TenantBridgePluginConfig } from "./config.js";
import type { TenantBridgeRuntime } from "./runtime.js";
import type {
  AccessGrant,
  ContextDelta,
  PromotionRequest,
  RecallQuery,
  RecallSurface,
} from "./types.js";

const recallSurfaceSchema = z.enum(["episodic", "durable", "artifact"]);

const artifactInputSchema = z.object({
  artifactId: z.string().optional(),
  name: z.string().optional(),
  contentType: z.string().optional(),
  contentText: z.string().optional(),
  contentBase64: z.string().optional(),
  url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const contextDeltaSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  appId: z.string().min(1),
  sessionId: z.string().min(1),
  source: z.string().optional(),
  timestamp: z.string().min(1),
  kind: z.enum(["message", "decision", "task", "fact", "summary", "artifact"]),
  content: z.string().min(1),
  artifacts: z.array(artifactInputSchema).optional(),
  tags: z.array(z.string()).optional(),
  idempotencyKey: z.string().min(1),
});

const deltaBatchSchema = z.union([
  contextDeltaSchema,
  z.object({
    deltas: z.array(contextDeltaSchema).min(1),
  }),
]);

const recallQuerySchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  appId: z.string().min(1),
  sessionId: z.string().optional(),
  query: z.string(),
  surfaces: z.array(recallSurfaceSchema).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tags: z.array(z.string()).optional(),
});

const promotionSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  appId: z.string().min(1),
  recordIds: z.array(z.string().min(1)).min(1),
});

const accessGrantSchema = z.object({
  tenantId: z.string().min(1),
  appId: z.string().min(1),
  grant: z.object({
    grantId: z.string().optional(),
    ownerUserId: z.string().min(1),
    targetUserId: z.string().min(1),
    surfaces: z.array(recallSurfaceSchema).min(1),
    appIds: z.array(z.string()).optional(),
    revoked: z.boolean().optional(),
    note: z.string().optional(),
  }),
});

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(`${JSON.stringify(body)}\n`);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function ensureTenant(params: {
  config: TenantBridgePluginConfig;
  tenantId: string;
}): { ok: true } | { ok: false; message: string } {
  if (params.tenantId !== params.config.tenantId) {
    return {
      ok: false,
      message: `tenant mismatch: expected ${params.config.tenantId}, received ${params.tenantId}`,
    };
  }
  return { ok: true };
}

function resolveRoutePath(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

function collectDeltas(payload: z.infer<typeof deltaBatchSchema>): ContextDelta[] {
  return "deltas" in payload ? payload.deltas : [payload];
}

export function createTenantBridgeHttpHandler(params: {
  config: TenantBridgePluginConfig;
  runtime: TenantBridgeRuntime;
  logger: PluginLogger;
}) {
  const basePath = "/plugins/tenant-bridge/v1";

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = resolveRoutePath(req.url);
    if (!pathname.startsWith(basePath)) {
      return false;
    }

    const method = (req.method || "GET").toUpperCase();
    const suffix = pathname.slice(basePath.length) || "/";

    try {
      if (method === "POST" && suffix === "/context-deltas") {
        const parsed = deltaBatchSchema.parse(await readJsonBody(req));
        const deltas = collectDeltas(parsed);
        const appId = deltas[0]?.appId;
        if (!appId) {
          sendJson(res, 400, { error: "missing appId" });
          return true;
        }
        const authResult = authorizeAppRequest({
          config: params.config,
          req,
          appId,
        });
        if (!authResult.ok) {
          sendJson(res, 403, { error: authResult.reason });
          return true;
        }
        for (const delta of deltas) {
          const tenantCheck = ensureTenant({
            config: params.config,
            tenantId: delta.tenantId,
          });
          if (!tenantCheck.ok) {
            sendJson(res, 403, { error: tenantCheck.message });
            return true;
          }
          if (delta.appId !== appId) {
            sendJson(res, 400, { error: "all deltas in a batch must share the same appId" });
            return true;
          }
          await params.runtime.enqueueDelta(delta);
        }
        await params.runtime.flush();
        sendJson(res, 202, { accepted: deltas.length });
        return true;
      }

      if (method === "POST" && suffix === "/retrieve") {
        const query = recallQuerySchema.parse(await readJsonBody(req)) as RecallQuery;
        const authResult = authorizeAppRequest({
          config: params.config,
          req,
          appId: query.appId,
        });
        if (!authResult.ok) {
          sendJson(res, 403, { error: authResult.reason });
          return true;
        }
        const tenantCheck = ensureTenant({
          config: params.config,
          tenantId: query.tenantId,
        });
        if (!tenantCheck.ok) {
          sendJson(res, 403, { error: tenantCheck.message });
          return true;
        }
        const result = await params.runtime.retrieve(query);
        sendJson(res, 200, result);
        return true;
      }

      if (method === "POST" && suffix === "/memory/promote") {
        const request = promotionSchema.parse(await readJsonBody(req)) as PromotionRequest;
        const authResult = authorizeAppRequest({
          config: params.config,
          req,
          appId: request.appId,
        });
        if (!authResult.ok) {
          sendJson(res, 403, { error: authResult.reason });
          return true;
        }
        const tenantCheck = ensureTenant({
          config: params.config,
          tenantId: request.tenantId,
        });
        if (!tenantCheck.ok) {
          sendJson(res, 403, { error: tenantCheck.message });
          return true;
        }
        const promoted = await params.runtime.promoteRecords(request);
        sendJson(res, 200, { promoted });
        return true;
      }

      if (method === "POST" && suffix === "/access-grants") {
        const payload = accessGrantSchema.parse(await readJsonBody(req));
        const authResult = authorizeAppRequest({
          config: params.config,
          req,
          appId: payload.appId,
        });
        if (!authResult.ok) {
          sendJson(res, 403, { error: authResult.reason });
          return true;
        }
        const tenantCheck = ensureTenant({
          config: params.config,
          tenantId: payload.tenantId,
        });
        if (!tenantCheck.ok) {
          sendJson(res, 403, { error: tenantCheck.message });
          return true;
        }
        const grant: AccessGrant = {
          grantId: payload.grant.grantId || "",
          tenantId: payload.tenantId,
          ownerUserId: payload.grant.ownerUserId,
          targetUserId: payload.grant.targetUserId,
          surfaces: payload.grant.surfaces as RecallSurface[],
          appIds: payload.grant.appIds,
          revoked: payload.grant.revoked,
          note: payload.grant.note,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const saved = await params.runtime.upsertAccessGrant(grant);
        sendJson(res, 200, { grant: saved });
        return true;
      }

      sendJson(res, 404, {
        error: `unknown tenant bridge route: ${method} ${suffix}`,
      });
      return true;
    } catch (error) {
      params.logger.warn(`[tenant-bridge] http handler failed: ${String(error)}`);
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };
}
