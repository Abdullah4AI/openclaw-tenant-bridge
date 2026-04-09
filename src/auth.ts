import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TenantBridgePluginConfig } from "./config.js";

function normalizeToken(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}

function extractBearerToken(headerValue: string | string[] | undefined): string | undefined {
  if (Array.isArray(headerValue)) {
    for (const entry of headerValue) {
      const resolved = extractBearerToken(entry);
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }
  const value = normalizeToken(headerValue);
  if (!value) {
    return undefined;
  }
  if (value.toLowerCase().startsWith("bearer ")) {
    return normalizeToken(value.slice("bearer ".length));
  }
  return undefined;
}

function safeTokenEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function resolveRequestToken(req: IncomingMessage): string | undefined {
  return (
    extractBearerToken(req.headers.authorization) ??
    normalizeToken(
      typeof req.headers["x-tenant-bridge-token"] === "string"
        ? req.headers["x-tenant-bridge-token"]
        : undefined,
    )
  );
}

export function authorizeAppRequest(params: {
  config: TenantBridgePluginConfig;
  req: IncomingMessage;
  appId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!params.config.bridge.allowedApps.includes(params.appId)) {
    return { ok: false, reason: `app not allowed: ${params.appId}` };
  }
  const expectedToken = params.config.bridge.serviceTokens[params.appId];
  if (!expectedToken) {
    return { ok: false, reason: `missing service token for app: ${params.appId}` };
  }
  const token = resolveRequestToken(params.req);
  if (!token || !safeTokenEquals(expectedToken, token)) {
    return { ok: false, reason: "invalid service token" };
  }
  return { ok: true };
}
