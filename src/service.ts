import type { OpenClawPluginService } from "../api.js";
import type { TenantBridgeRuntime } from "./runtime.js";

export function createTenantBridgeService(params: {
  runtime: TenantBridgeRuntime;
}): OpenClawPluginService {
  return {
    id: "tenant-bridge-sync",
    start: async (context: Parameters<NonNullable<OpenClawPluginService["start"]>>[0]) => {
      await params.runtime.start(context);
    },
    stop: async () => {
      await params.runtime.stop();
    },
  };
}
