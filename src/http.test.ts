import { describe, expect, it } from "vitest";
import {
  createMockIncomingRequest,
  createMockServerResponse,
} from "../test-support/mock-http.js";
import { createTestPluginApi } from "../test-support/plugin-api.js";
import { resolveTenantBridgePluginConfig } from "./config.js";
import { createTenantBridgeHttpHandler } from "./http.js";
import { createTenantBridgeRuntime } from "./runtime.js";
import { InMemoryTenantBridgeStore } from "./storage.js";

function createHandler() {
  const config = resolveTenantBridgePluginConfig({
    tenantId: "tenant-a",
    bridge: {
      allowedApps: ["codex"],
      serviceTokens: {
        codex: "secret-token",
      },
    },
  });
  const runtime = createTenantBridgeRuntime({
    api: createTestPluginApi(),
    config,
    store: new InMemoryTenantBridgeStore(),
  });
  return {
    config,
    runtime,
    handler: createTenantBridgeHttpHandler({
      config,
      runtime,
      logger: createTestPluginApi().logger,
    }),
  };
}

function createJsonRequest(params: { url: string; body: unknown; token?: string }) {
  const req = createMockIncomingRequest([JSON.stringify(params.body)]);
  req.method = "POST";
  req.url = params.url;
  req.headers = params.token
    ? {
        authorization: `Bearer ${params.token}`,
      }
    : {};
  return req;
}

describe("tenant-bridge http routes", () => {
  it("accepts authenticated context deltas and returns them via retrieve", async () => {
    const { handler } = createHandler();
    const ingestRes = createMockServerResponse();
    const ingestReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/context-deltas",
      token: "secret-token",
      body: {
        deltas: [
          {
            tenantId: "tenant-a",
            userId: "alice",
            appId: "codex",
            sessionId: "session-one",
            source: "codex-adapter",
            timestamp: new Date().toISOString(),
            kind: "fact",
            content: "Alice deploys to the staging Vercel project first.",
            tags: ["deployment"],
            idempotencyKey: "delta-1",
          },
        ],
      },
    });

    expect(await handler(ingestReq, ingestRes)).toBe(true);
    expect(ingestRes.statusCode).toBe(202);

    const retrieveRes = createMockServerResponse();
    const retrieveReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/retrieve",
      token: "secret-token",
      body: {
        tenantId: "tenant-a",
        userId: "alice",
        appId: "codex",
        query: "staging Vercel project",
      },
    });

    expect(await handler(retrieveReq, retrieveRes)).toBe(true);
    expect(retrieveRes.statusCode).toBe(200);
    const payload = JSON.parse(retrieveRes.body ?? "{}") as {
      results: Array<{ content: string }>;
    };
    expect(payload.results[0]?.content).toContain("staging Vercel project");
  });

  it("rejects requests with an invalid service token", async () => {
    const { handler } = createHandler();
    const response = createMockServerResponse();
    const request = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/retrieve",
      token: "wrong-token",
      body: {
        tenantId: "tenant-a",
        userId: "alice",
        appId: "codex",
        query: "anything",
      },
    });

    expect(await handler(request, response)).toBe(true);
    expect(response.statusCode).toBe(403);
  });
});
