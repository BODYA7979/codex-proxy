import type { ResponseRequest } from "../types/openai.js";
import { CallerRequestError } from "../caller/errors.js";

const supported = new Set([
  "model", "input", "stream", "reasoning", "instructions", "temperature", "top_p", "max_output_tokens", "user",
  "tools", "tool_choice", "parallel_tool_calls", "text", "store", "response_format", "previous_response_id", "metadata",
  "codex_proxy", "tool_execution_mode", "background", "conversation", "include", "truncation",
  "prompt_cache_key", "safety_identifier", "prompt_cache_retention", "prompt_cache_options", "service_tier", "stream_options",
]);
// Only documented nullable fields are equivalent to omission. Unknown options
// must still fail even when their value happens to be null.
const nullable = new Set([
  "background", "context_management", "conversation", "include", "instructions", "max_output_tokens", "max_tool_calls",
  "metadata", "moderation", "parallel_tool_calls", "previous_response_id", "prompt", "prompt_cache_key", "prompt_cache_retention",
  "reasoning", "safety_identifier", "service_tier", "store", "stream", "stream_options", "temperature", "top_logprobs", "top_p", "truncation", "user",
]);
type NormalizedResponseRequest = { [K in keyof ResponseRequest]: Exclude<ResponseRequest[K], null> };

function unsupported(key: string): never { throw new CallerRequestError(`Unsupported Responses option: ${key}`, 400, "unsupported_parameter"); }
function object(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallerRequestError(`${key} must be an object`);
  return { ...value };
}

/** Normalize SDK defaults before ownership, continuation and execution. */
export function normalizeResponsesRequest(request: ResponseRequest): NormalizedResponseRequest {
  const raw = { ...request } as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined || (raw[key] === null && nullable.has(key))) { delete raw[key]; continue; }
    if ((key === "top_logprobs" && raw[key] === 0) || (key === "context_management" && Array.isArray(raw[key]) && !raw[key].length)) { delete raw[key]; continue; }
    if (!supported.has(key)) unsupported(key);
  }
  if (raw.background !== undefined && raw.background !== false) unsupported("background");
  if (raw.conversation !== undefined) unsupported("conversation");
  if (raw.include !== undefined && (!Array.isArray(raw.include) || raw.include.length)) unsupported("include");
  if (raw.truncation !== undefined && raw.truncation !== "disabled") unsupported("truncation");
  if (raw.service_tier !== undefined && !["auto", "default", "flex", "priority", "fast", "scale", "ultrafast"].includes(raw.service_tier as string)) throw new CallerRequestError("Invalid service_tier");
  if (raw.prompt_cache_retention !== undefined && !["in_memory", "24h"].includes(raw.prompt_cache_retention as string)) throw new CallerRequestError("Invalid prompt_cache_retention");
  if (raw.prompt_cache_options !== undefined) {
    const cache = object(raw.prompt_cache_options, "prompt_cache_options");
    for (const key of Object.keys(cache)) {
      if (!["mode", "ttl", "prewarm", "comparison_response_id"].includes(key)) unsupported(`prompt_cache_options.${key}`);
    }
    if (cache.mode !== undefined && cache.mode !== "implicit") unsupported("prompt_cache_options.mode");
    if (cache.ttl !== undefined && cache.ttl !== "30m") unsupported("prompt_cache_options.ttl");
    if (cache.prewarm !== undefined && cache.prewarm !== false) unsupported("prompt_cache_options.prewarm");
    if (cache.comparison_response_id != null) unsupported("prompt_cache_options.comparison_response_id");
  }
  if (raw.stream_options !== undefined) {
    const stream = object(raw.stream_options, "stream_options");
    for (const key of Object.keys(stream)) if (key !== "include_obfuscation") unsupported(`stream_options.${key}`);
    if (stream.include_obfuscation !== undefined && typeof stream.include_obfuscation !== "boolean") throw new CallerRequestError("stream_options.include_obfuscation must be a boolean");
    if (raw.stream !== true) throw new CallerRequestError("stream_options requires stream: true");
  }
  if (raw.reasoning != null && typeof raw.reasoning === "object" && !Array.isArray(raw.reasoning)) {
    const reasoning = { ...raw.reasoning } as Record<string, unknown>;
    for (const key of ["effort", "summary", "generate_summary", "context"]) if (reasoning[key] === null) delete reasoning[key];
    if (Object.keys(reasoning).length) raw.reasoning = reasoning; else delete raw.reasoning;
  }
  if (raw.text != null && typeof raw.text === "object" && !Array.isArray(raw.text)) {
    const text = { ...raw.text } as Record<string, unknown>;
    if (text.verbosity === null) delete text.verbosity;
    if (text.verbosity !== undefined && !["low", "medium", "high"].includes(text.verbosity as string)) throw new CallerRequestError("Invalid text.verbosity");
    if (text.format && typeof text.format === "object" && !Array.isArray(text.format)) {
      const format = { ...text.format } as Record<string, unknown>;
      if (format.strict === null) delete format.strict;
      text.format = format;
    }
    if (Object.keys(text).length) raw.text = text; else delete raw.text;
  }
  return raw as NormalizedResponseRequest;
}
