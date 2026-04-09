import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "./test-support/plugin-api.js";
import plugin from "./index.js";

describe("tenant-bridge plugin entry", () => {
  it("registers the context engine, http route, and background service", () => {
    const registerContextEngine = vi.fn();
    const registerHttpRoute = vi.fn();
    const registerService = vi.fn();

    plugin.register(
      createTestPluginApi({
        pluginConfig: {
          tenantId: "tenant-a",
          bridge: {
            serviceTokens: {
              codex: "secret",
            },
          },
        },
        registerContextEngine,
        registerHttpRoute,
        registerService,
      }),
    );

    expect(registerContextEngine).toHaveBeenCalledWith("tenant-bridge", expect.any(Function));
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/plugins/tenant-bridge/v1",
        auth: "plugin",
        match: "prefix",
      }),
    );
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tenant-bridge-sync",
      }),
    );
  });
});
