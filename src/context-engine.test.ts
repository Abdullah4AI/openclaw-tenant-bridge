import { describe, expect, it } from "vitest";
import type { ContextEngine } from "../api.js";
import { createTestPluginApi } from "../test-support/plugin-api.js";
import { resolveTenantBridgePluginConfig } from "./config.js";
import { createTenantBridgeContextEngine } from "./context-engine.js";
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

function createRuntime() {
  const config = resolveTenantBridgePluginConfig({
    tenantId: "tenant-a",
  });
  return {
    config,
    runtime: createTenantBridgeRuntime({
      api: createTestPluginApi(),
      config,
      store: new InMemoryTenantBridgeStore(),
    }),
  };
}

describe("tenant-bridge context engine", () => {
  it("injects shared recall for the same user across apps", async () => {
    const { config, runtime } = createRuntime();
    const engine = createTenantBridgeContextEngine({
      config,
      runtime,
    });
    if (!engine.afterTurn) {
      throw new Error("tenant-bridge context engine must implement afterTurn");
    }

    await engine.afterTurn({
      sessionId: "session-one",
      sessionKey: "agent:alice:main",
      sessionFile: "/tmp/session-one.json",
      messages: [
        makeMessage("user", "Project Phoenix deadline is May 1", 1),
        makeMessage("assistant", "Noted", 2),
      ],
      prePromptMessageCount: 0,
    });

    const assembled = await engine.assemble({
      sessionId: "session-two",
      sessionKey: "agent:alice:main",
      messages: [makeMessage("user", "When is the Phoenix deadline?", 3)],
      prompt: "Phoenix deadline",
      availableTools: new Set(["memory_search"]),
    });

    expect(assembled.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
      }),
    );
    expect(String((assembled.messages[0] as { content?: unknown })?.content)).toContain(
      "Project Phoenix deadline is May 1",
    );
    expect(assembled.systemPromptAddition).toContain("Relevant shared recall");
  });

  it("enforces cross-user access grants during retrieval", async () => {
    const { config, runtime } = createRuntime();

    await runtime.enqueueDelta({
      tenantId: config.tenantId,
      userId: "alice",
      appId: "openclaw",
      sessionId: "session-one",
      source: "test",
      timestamp: new Date().toISOString(),
      kind: "fact",
      content: "Alice prefers markdown task lists.",
      tags: ["preference"],
      idempotencyKey: "delta-1",
    });

    let result = await runtime.retrieve({
      tenantId: config.tenantId,
      userId: "bob",
      appId: "codex",
      query: "markdown task lists",
    });
    expect(result.results).toHaveLength(0);

    const activeGrant = await runtime.upsertAccessGrant({
      grantId: "",
      tenantId: config.tenantId,
      ownerUserId: "alice",
      targetUserId: "bob",
      surfaces: ["durable"],
      appIds: ["codex"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    result = await runtime.retrieve({
      tenantId: config.tenantId,
      userId: "bob",
      appId: "codex",
      query: "markdown task lists",
    });
    expect(result.results).toHaveLength(1);

    await runtime.upsertAccessGrant({
      ...activeGrant,
      revoked: true,
    });

    result = await runtime.retrieve({
      tenantId: config.tenantId,
      userId: "bob",
      appId: "codex",
      query: "markdown task lists",
    });
    expect(result.results).toHaveLength(0);
  });
});
