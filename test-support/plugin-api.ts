import type { OpenClawPluginApi, PluginLogger } from "../api.js";

type TestPluginApiOptions = {
  pluginConfig?: Record<string, unknown>;
  registerContextEngine?: (...args: unknown[]) => unknown;
  registerHttpRoute?: (...args: unknown[]) => unknown;
  registerService?: (...args: unknown[]) => unknown;
};

function createLogger(): PluginLogger {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger as unknown as PluginLogger;
}

export function createTestPluginApi(options: TestPluginApiOptions = {}): OpenClawPluginApi {
  return {
    pluginConfig: options.pluginConfig ?? {},
    logger: createLogger(),
    resolvePath(value: string) {
      return value;
    },
    registerContextEngine: options.registerContextEngine ?? (() => undefined),
    registerHttpRoute: options.registerHttpRoute ?? (() => undefined),
    registerService: options.registerService ?? (() => undefined),
  } as unknown as OpenClawPluginApi;
}
