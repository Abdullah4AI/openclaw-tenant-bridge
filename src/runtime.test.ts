import { describe, expect, it } from "vitest";
import type { ContextEngine } from "../api.js";
import { createMockIncomingRequest, createMockServerResponse } from "../test-support/mock-http.js";
import { createTestPluginApi } from "../test-support/plugin-api.js";
import { resolveTenantBridgePluginConfig } from "./config.js";
import { createTenantBridgeContextEngine } from "./context-engine.js";
import { createTenantBridgeHttpHandler } from "./http.js";
import { createTenantBridgeRuntime } from "./runtime.js";
import { InMemoryTenantBridgeStore } from "./storage.js";

type ContextEngineMessage = Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]["messages"][number];

function makeMessage(
  role: "user" | "assistant",
  content: string,
  timestamp: number,
): ContextEngineMessage {
  return { role, content, timestamp } as ContextEngineMessage;
}

function createHarness(params?: {
  tenantId?: string;
  store?: InMemoryTenantBridgeStore;
  allowedApps?: string[];
  serviceTokens?: Record<string, string>;
}) {
  const api = createTestPluginApi();
  const config = resolveTenantBridgePluginConfig({
    tenantId: params?.tenantId ?? "tenant-a",
    bridge: {
      allowedApps: params?.allowedApps ?? ["codex", "chatgpt", "claude-code"],
      serviceTokens: params?.serviceTokens ?? {
        codex: "secret-token",
        chatgpt: "chatgpt-token",
        "claude-code": "claude-token",
      },
    },
  });
  const store = params?.store ?? new InMemoryTenantBridgeStore();
  const runtime = createTenantBridgeRuntime({
    api,
    config,
    store,
  });
  const engine = createTenantBridgeContextEngine({
    config,
    runtime,
  });
  const handler = createTenantBridgeHttpHandler({
    config,
    runtime,
    logger: api.logger,
  });

  return {
    config,
    store,
    runtime,
    engine,
    handler,
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

describe("tenant-bridge runtime", () => {
  it("keeps tenant storage and retrieval isolated", async () => {
    const sharedStore = new InMemoryTenantBridgeStore();
    const tenantA = createHarness({
      tenantId: "tenant-a",
      store: sharedStore,
    });
    const tenantB = createHarness({
      tenantId: "tenant-b",
      store: sharedStore,
    });

    await tenantA.runtime.enqueueDelta({
      tenantId: "tenant-a",
      userId: "alice",
      appId: "codex",
      sessionId: "session-a",
      source: "codex-adapter",
      timestamp: new Date().toISOString(),
      kind: "fact",
      content: "Tenant A runbook lives in the blue bucket.",
      tags: ["runbook"],
      idempotencyKey: "tenant-a-1",
    });
    await tenantB.runtime.enqueueDelta({
      tenantId: "tenant-b",
      userId: "alice",
      appId: "codex",
      sessionId: "session-b",
      source: "codex-adapter",
      timestamp: new Date().toISOString(),
      kind: "fact",
      content: "Tenant B runbook lives in the green bucket.",
      tags: ["runbook"],
      idempotencyKey: "tenant-b-1",
    });

    await tenantA.runtime.flush();
    await tenantB.runtime.flush();

    expect(await sharedStore.listRecords({ tenantId: "tenant-a" })).toHaveLength(1);
    expect(await sharedStore.listRecords({ tenantId: "tenant-b" })).toHaveLength(1);

    const tenantAResult = await tenantA.runtime.retrieve({
      tenantId: "tenant-a",
      userId: "alice",
      appId: "codex",
      query: "blue bucket runbook",
    });
    const tenantBResult = await tenantB.runtime.retrieve({
      tenantId: "tenant-b",
      userId: "alice",
      appId: "codex",
      query: "green bucket runbook",
    });

    expect(tenantAResult.results).toHaveLength(1);
    expect(tenantAResult.results[0]?.tenantId).toBe("tenant-a");
    expect(tenantAResult.results[0]?.content).toContain("blue bucket");
    expect(tenantBResult.results).toHaveLength(1);
    expect(tenantBResult.results[0]?.tenantId).toBe("tenant-b");
    expect(tenantBResult.results[0]?.content).toContain("green bucket");
  });

  it("rewrites context into bounded storage surfaces before retrieval", async () => {
    const { config, store, runtime } = createHarness();
    const longTranscript = `  ${"x".repeat(1_200)}  `;

    await runtime.enqueueDelta({
      tenantId: config.tenantId,
      userId: "alice",
      appId: "codex",
      sessionId: "rewrite-session",
      source: "codex-adapter",
      timestamp: new Date().toISOString(),
      kind: "message",
      content: longTranscript,
      tags: ["transcript"],
      idempotencyKey: "rewrite-message",
    });
    await runtime.enqueueDelta({
      tenantId: config.tenantId,
      userId: "alice",
      appId: "codex",
      sessionId: "rewrite-session",
      source: "codex-adapter",
      timestamp: new Date().toISOString(),
      kind: "task",
      content: "Task: rotate tenant keys before Friday.",
      tags: ["task"],
      idempotencyKey: "rewrite-task",
    });

    await runtime.flush();

    const records = await store.listRecords({
      tenantId: config.tenantId,
      userId: "alice",
    });
    const episodicRecord = records.find((record) => record.idempotencyKey === "rewrite-message");
    const durableRecord = records.find((record) => record.idempotencyKey === "rewrite-task");

    expect(episodicRecord?.surface).toBe("episodic");
    expect(episodicRecord?.content).toHaveLength(1_000);
    expect(episodicRecord?.content).toBe("x".repeat(1_000));
    expect(durableRecord?.surface).toBe("durable");
    expect(durableRecord?.content).toBe("Task: rotate tenant keys before Friday.");
  });

  it("enforces permissions for bridge retrieval requests", async () => {
    const { config, handler } = createHarness();
    const ingestRes = createMockServerResponse();
    const ingestReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/context-deltas",
      token: "secret-token",
      body: {
        deltas: [
          {
            tenantId: config.tenantId,
            userId: "alice",
            appId: "codex",
            sessionId: "codex-session",
            source: "codex-adapter",
            timestamp: new Date().toISOString(),
            kind: "fact",
            content: "Alice owns the quarterly board deck.",
            tags: ["ownership"],
            idempotencyKey: "grant-delta",
          },
        ],
      },
    });

    expect(await handler(ingestReq, ingestRes)).toBe(true);
    expect(ingestRes.statusCode).toBe(202);

    const unauthorizedRetrieveRes = createMockServerResponse();
    const unauthorizedRetrieveReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/retrieve",
      token: "secret-token",
      body: {
        tenantId: config.tenantId,
        userId: "bob",
        appId: "codex",
        query: "board deck",
      },
    });

    expect(await handler(unauthorizedRetrieveReq, unauthorizedRetrieveRes)).toBe(true);
    expect(
      JSON.parse(unauthorizedRetrieveRes.body ?? "{}") as {
        results?: unknown[];
      },
    ).toEqual(
      expect.objectContaining({
        results: [],
      }),
    );

    const grantRes = createMockServerResponse();
    const grantReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/access-grants",
      token: "secret-token",
      body: {
        tenantId: config.tenantId,
        appId: "codex",
        grant: {
          ownerUserId: "alice",
          targetUserId: "bob",
          surfaces: ["durable"],
          appIds: ["codex"],
        },
      },
    });

    expect(await handler(grantReq, grantRes)).toBe(true);
    expect(grantRes.statusCode).toBe(200);

    const authorizedRetrieveRes = createMockServerResponse();
    const authorizedRetrieveReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/retrieve",
      token: "secret-token",
      body: {
        tenantId: config.tenantId,
        userId: "bob",
        appId: "codex",
        query: "board deck",
      },
    });

    expect(await handler(authorizedRetrieveReq, authorizedRetrieveRes)).toBe(true);
    const authorizedPayload = JSON.parse(authorizedRetrieveRes.body ?? "{}") as {
      results: Array<{ content: string }>;
    };
    expect(authorizedPayload.results).toHaveLength(1);
    expect(authorizedPayload.results[0]?.content).toContain("board deck");
  });

  it("smoke-tests the end-to-end OpenClaw to bridge path without duplicate writes", async () => {
    const { config, engine, handler, runtime, store } = createHarness();
    const userMessage = makeMessage(
      "user",
      "Remember: production deploys must wait for staging sign-off.",
      1,
    );
    const assistantMessage = makeMessage("assistant", "Noted and stored.", 2);

    const ingestResult = await engine.ingest({
      sessionId: "session-one",
      sessionKey: "agent:alice:main",
      message: userMessage,
      isHeartbeat: false,
    });
    expect(ingestResult.ingested).toBe(false);

    if (!engine.afterTurn) {
      throw new Error("tenant-bridge context engine must implement afterTurn");
    }
    await engine.afterTurn({
      sessionId: "session-one",
      sessionKey: "agent:alice:main",
      sessionFile: "/tmp/session-one.json",
      messages: [userMessage, assistantMessage],
      prePromptMessageCount: 0,
    });
    await runtime.flush();

    const records = await store.listRecords({
      tenantId: config.tenantId,
      userId: "alice",
    });
    expect(
      records.filter((record) => record.content.includes("staging sign-off")),
    ).toHaveLength(1);

    const retrieveRes = createMockServerResponse();
    const retrieveReq = createJsonRequest({
      url: "/plugins/tenant-bridge/v1/retrieve",
      token: "secret-token",
      body: {
        tenantId: config.tenantId,
        userId: "alice",
        appId: "codex",
        query: "staging sign-off",
      },
    });

    expect(await handler(retrieveReq, retrieveRes)).toBe(true);
    expect(retrieveRes.statusCode).toBe(200);
    const payload = JSON.parse(retrieveRes.body ?? "{}") as {
      results: Array<{ content: string }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.content).toContain("staging sign-off");
  });
});
