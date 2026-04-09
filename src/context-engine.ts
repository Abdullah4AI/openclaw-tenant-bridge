import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
  type ContextEngine,
  type ContextEngineInfo,
} from "../api.js";
import type { TenantBridgePluginConfig } from "./config.js";
import type { TenantBridgeRuntime } from "./runtime.js";

type ContextEngineMessage = Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]["messages"][number];

function readAgentMessageContent(message: ContextEngineMessage): unknown {
  return "content" in message ? message.content : undefined;
}

export function createTenantBridgeContextEngine(params: {
  config: TenantBridgePluginConfig;
  runtime: TenantBridgeRuntime;
}): ContextEngine {
  const info: ContextEngineInfo = {
    id: "tenant-bridge",
    name: "Tenant Bridge Context Engine",
    version: "0.1.0",
    ownsCompaction: false,
  };

  return {
    info,
    async ingest({ message }: Parameters<ContextEngine["ingest"]>[0]) {
      // OpenClaw also calls afterTurn() with the full turn batch. Persisting in
      // one place avoids duplicate memories while keeping assemble() retrieval.
      void params.runtime.messageContentToText(readAgentMessageContent(message));
      return { ingested: false };
    },
    async afterTurn({
      sessionId,
      sessionKey,
      messages,
      prePromptMessageCount,
      autoCompactionSummary,
      isHeartbeat,
    }: NonNullable<ContextEngine["afterTurn"]> extends (params: infer P) => Promise<void>
      ? P
      : never) {
      await params.runtime.ingestOpenClawMessages({
        sessionId,
        sessionKey,
        messages,
        prePromptMessageCount,
        autoCompactionSummary,
        isHeartbeat,
      });
    },
    async assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget,
      availableTools = new Set<string>(),
      citationsMode,
      prompt,
    }: Parameters<ContextEngine["assemble"]>[0]) {
      const userId = params.runtime.resolveUserIdFromSessionKey(sessionKey);
      const queryMessage =
        prompt?.trim() ||
        [...messages]
          .toReversed()
          .find(
            (message) =>
              message.role === "user" &&
              params.runtime.messageContentToText(readAgentMessageContent(message)),
          );
      const query =
        typeof queryMessage === "string"
          ? queryMessage
          : params.runtime.messageContentToText(
              queryMessage ? readAgentMessageContent(queryMessage) : undefined,
            );
      const { message, promptSummary } = await params.runtime.buildRecallMessage({
        query: {
          tenantId: params.config.tenantId,
          userId,
          appId: "openclaw",
          sessionId,
          query,
          limit: tokenBudget && tokenBudget < 1_000 ? 3 : undefined,
        },
      });
      const memoryPromptAddition = buildMemorySystemPromptAddition({
        availableTools,
        citationsMode,
      });
      const systemPromptAddition =
        params.config.recall.includeSystemPromptSummary && promptSummary
          ? [memoryPromptAddition, promptSummary].filter(Boolean).join("\n\n")
          : memoryPromptAddition;

      return {
        messages: message ? ([message, ...messages] as typeof messages) : messages,
        estimatedTokens: 0,
        systemPromptAddition,
      };
    },
    async compact(compactParams: Parameters<ContextEngine["compact"]>[0]) {
      return await delegateCompactionToRuntime(compactParams);
    },
    async dispose() {
      await params.runtime.flush();
    },
  };
}
