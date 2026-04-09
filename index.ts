import { definePluginEntry } from "./api.js";
import { tenantBridgePluginConfigSchema, resolveTenantBridgePluginConfig } from "./src/config.js";
import { createTenantBridgeContextEngine } from "./src/context-engine.js";
import { createTenantBridgeHttpHandler } from "./src/http.js";
import { createTenantBridgeRuntime } from "./src/runtime.js";
import { createTenantBridgeService } from "./src/service.js";

export default definePluginEntry({
  id: "tenant-bridge",
  name: "Tenant Bridge",
  description:
    "Multi-tenant shared memory bridge for OpenClaw and external apps such as Codex and Claude Code.",
  kind: "context-engine",
  configSchema: tenantBridgePluginConfigSchema,
  register(api) {
    const config = resolveTenantBridgePluginConfig(api.pluginConfig);
    const runtime = createTenantBridgeRuntime({
      api,
      config,
    });

    api.registerContextEngine("tenant-bridge", () =>
      createTenantBridgeContextEngine({
        config,
        runtime,
      }),
    );

    api.registerHttpRoute({
      path: "/plugins/tenant-bridge/v1",
      auth: "plugin",
      match: "prefix",
      handler: createTenantBridgeHttpHandler({
        config,
        runtime,
        logger: api.logger,
      }),
    });

    api.registerService(
      createTenantBridgeService({
        runtime,
      }),
    );
  },
});
