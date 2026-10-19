import { AVAILABLE_MODELS } from "../adapter/openai-to-codex.js";
import { CodexSubprocess, type CodexSubprocessOptions } from "../subprocess/manager.js";
import type { ModelListParams, ModelListResponse } from "../types/codex.js";
import { CONFIG } from "./config.js";
import { logError, trace } from "./trace.js";

interface ModelDiscoveryClient {
  start(options: CodexSubprocessOptions): Promise<unknown>;
  listModels(params: ModelListParams): Promise<ModelListResponse>;
  kill(): void;
}

let availableModels: readonly string[] = AVAILABLE_MODELS;

interface RefreshAttempt {
  client?: ModelDiscoveryClient;
  cancelled: boolean;
  promise?: Promise<boolean>;
}

interface BackgroundRefresh {
  timer?: ReturnType<typeof setTimeout>;
}

let activeRefresh: RefreshAttempt | undefined;
let backgroundRefresh: BackgroundRefresh | undefined;

/** Models for API responses, initially populated from the built-in fallback. */
export function getAvailableModels(): readonly string[] {
  return availableModels;
}

/** Refresh the model catalog without blocking startup or losing the current list on failure. */
export function refreshAvailableModels(
  createClient: () => ModelDiscoveryClient = () => new CodexSubprocess(),
): Promise<boolean> {
  if (activeRefresh?.promise) return activeRefresh.promise;
  const attempt: RefreshAttempt = { cancelled: false };
  activeRefresh = attempt;
  attempt.promise = discoverAvailableModels(attempt, createClient).finally(() => {
    if (activeRefresh === attempt) activeRefresh = undefined;
  });
  return attempt.promise;
}

async function discoverAvailableModels(
  attempt: RefreshAttempt,
  createClient: () => ModelDiscoveryClient,
): Promise<boolean> {
  let stage = "initialize";
  try {
    const client = attempt.client = createClient();
    await client.start({ model: CONFIG.defaultModel });

    stage = "model/list";
    const discovered: string[] = [];
    let cursor: string | null | undefined;
    do {
      if (attempt.cancelled) return false;
      const page = await client.listModels({ cursor, includeHidden: false });
      discovered.push(...page.data.map((model) => model.model || model.id));
      cursor = page.nextCursor;
    } while (cursor);

    if (attempt.cancelled) return false;
    const models = [...new Set(discovered.filter(Boolean))];
    if (models.length === 0) {
      logError("models.refresh.empty", new Error("Codex returned an empty model catalog"), {
        stage, retainedModelCount: availableModels.length,
      });
      return false;
    }

    availableModels = models;
    trace("models.refresh.success", { count: models.length, models });
    return true;
  } catch (err) {
    if (!attempt.cancelled) {
      logError("models.refresh.error", err, { stage, retainedModelCount: availableModels.length });
    }
    return false;
  } finally {
    attempt.client?.kill();
  }
}

/** Start one non-overlapping refresh loop, immediately discovering the current catalog. */
export function startModelRefresh(
  createClient: () => ModelDiscoveryClient = () => new CodexSubprocess(),
): void {
  if (backgroundRefresh) return;
  const loop: BackgroundRefresh = {};
  backgroundRefresh = loop;

  const refresh = async (): Promise<void> => {
    const success = await refreshAvailableModels(createClient);
    if (backgroundRefresh !== loop) return;
    loop.timer = setTimeout(() => void refresh(), success
      ? CONFIG.modelRefreshIntervalMs
      : CONFIG.modelRefreshRetryMs);
    loop.timer.unref();
  };
  void refresh();
}

/** Cancel scheduled work and discard results from any discovery interrupted by shutdown. */
export async function stopModelRefresh(): Promise<void> {
  if (backgroundRefresh?.timer) clearTimeout(backgroundRefresh.timer);
  backgroundRefresh = undefined;
  const attempt = activeRefresh;
  if (attempt) {
    attempt.cancelled = true;
    attempt.client?.kill();
    await attempt.promise;
  }
}
