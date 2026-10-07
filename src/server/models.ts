import { AVAILABLE_MODELS } from "../adapter/openai-to-codex.js";
import { CodexSubprocess, type CodexSubprocessOptions } from "../subprocess/manager.js";
import type { ModelListParams, ModelListResponse } from "../types/codex.js";
import { CONFIG } from "./config.js";
import { trace, traceError } from "./trace.js";

interface ModelDiscoveryClient {
  start(options: CodexSubprocessOptions): Promise<unknown>;
  listModels(params: ModelListParams): Promise<ModelListResponse>;
  kill(): void;
}

let availableModels: readonly string[] = AVAILABLE_MODELS;

/** Models for API responses, initially populated from the built-in fallback. */
export function getAvailableModels(): readonly string[] {
  return availableModels;
}

/** Refresh the model catalog without blocking startup or losing the current list on failure. */
export async function refreshAvailableModels(
  createClient: () => ModelDiscoveryClient = () => new CodexSubprocess(),
): Promise<boolean> {
  const client = createClient();
  try {
    await client.start({ model: CONFIG.defaultModel });

    const discovered: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await client.listModels({ cursor, includeHidden: false });
      discovered.push(...page.data.map((model) => model.model || model.id));
      cursor = page.nextCursor;
    } while (cursor);

    const models = [...new Set(discovered.filter(Boolean))];
    if (models.length === 0) {
      trace("models.refresh.empty", {});
      return false;
    }

    availableModels = models;
    trace("models.refresh.success", { count: models.length, models });
    return true;
  } catch (err) {
    traceError("models.refresh.error", err);
    return false;
  } finally {
    client.kill();
  }
}
