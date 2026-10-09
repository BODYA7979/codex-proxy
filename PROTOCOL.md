# Protocol mapping

## Chat completions

Client request:

```http
POST /v1/chat/completions
```

The proxy converts `messages[]` into:

- first `system`/`developer` message -> Codex `baseInstructions`
- `assistant` messages -> `<previous_response>` blocks
- `user` messages -> prompt text

Then it sends Codex app-server JSON-RPC:

```json
{ "method": "initialize", "id": 1, "params": { "clientInfo": { "name": "codex-proxy" } } }
{ "method": "initialized", "params": {} }
{ "method": "thread/start", "id": 2, "params": { "model": "gpt-5.5", "ephemeral": true } }
{ "method": "turn/start", "id": 3, "params": { "threadId": "...", "input": [{ "type": "text", "text": "..." }] } }
```

In `pool` runtime, `initialize` and `initialized` happen once per app-server worker. `thread/start` and `turn/start` still happen per request with `ephemeral: true`.

In opt-in sticky mode (`CODEX_PROXY_STICKY_SESSIONS=1` and a valid `X-Codex-Proxy-Session-Key` header, or legacy `CODEX_PROXY_SESSIONS=1` plus `X-Codex-Proxy-Session`), `initialize`, `initialized`, and `thread/start` happen once per sticky session key/fingerprint. Later sequential requests for that same hashed session key, model, cwd hash, instruction/config fingerprint, sandbox, approval policy, and session policy call `turn/start` on the stored thread id. Session workers are killed on idle TTL, absolute TTL, LRU eviction, reset, abort, dead worker, or turn failure.

Session controls can be sent as headers (`X-Codex-Proxy-Session-Mode: pool|sticky|stateless`, `X-Codex-Proxy-Session-TTL-Seconds`, `X-Codex-Proxy-Session-Reset`, `X-Codex-Proxy-Session-Policy`) or as a `codex_proxy` body extension with matching snake/camel-case aliases. `stateless` forces one-shot for a request. Raw session keys are hashed for diagnostics and are never used as metric labels.

Deltas from `item/agentMessage/delta` become OpenAI streaming chunks:

```text
data: {"object":"chat.completion.chunk", ...}
```

`turn/completed` emits the final stop chunk and `[DONE]`.

Streaming endpoints may include SSE comment keepalives:

```text
:ok

```

These comments do not carry JSON data and should be ignored by SSE clients.

## Caller tool execution

With `CODEX_PROXY_TOOL_EXECUTION_MODE=caller` (or a Chat Completions request override), initialization opts into `experimentalApi`; `thread/start` registers client function schemas through `dynamicTools`. A dedicated inference adapter enforces the allowed tool list and `tool_choice` before app-server receives model output. Calls use internal aliases and are returned to OpenAI clients with original names and random stable call IDs.

`item/tool/call` is a server RPC request awaiting `DynamicToolCallResponse`. HTTP returns `message.tool_calls` or indexed SSE `delta.tool_calls` with `finish_reason: "tool_calls"`, retaining assistant text. The following HTTP request supplies a complete batch of `role: "tool"` messages. Matching results resolve those RPCs as `{contentItems:[{type:"inputText",text:...}],success:true}`. The original running turn continues and can request another batch; client result messages are not flattened for this continuation.

Caller sessions are separate from hybrid/sticky workers, isolated by client identity and pending IDs, bounded by capacity and idle TTL, and closed on disconnect, explicit cancellation, failure or shutdown. SSE inference is buffered at the execution guard before validated events enter app-server. See [caller tools](docs/caller-tools.md) for lifecycle and runtime limits.

## Responses

`/v1/responses` and `/responses` accept native function definitions and emit `function_call` output items. `call_id` correlates client `function_call_output` items with the same dynamic RPCs used by caller Chat Completions. Relative message/call order is retained. External functions execute on the client; hybrid mode retains configured Codex-native tools.

`previous_response_id` resolves owner-isolated in-memory input/output history with TTL, entry and byte limits. Pending batches require exactly one result per call and cannot be consumed twice. Full explicit call/output histories can be replayed without a response reference. `store:false` disables the response-reference cache; restart and expiry invalidate cached references.

Streaming emits the standard created/in-progress, message content, function-argument, item-done, completed/failed events, each with a monotonic `sequence_number`. Tool-enabled turns are buffered for validation before publishing text or calls. Codex summary events may omit output items already emitted as `response.output_item.done`; the adapter preserves those completed items. Text-only hybrid turns retain live text deltas.

See [Responses function calling](docs/responses-function-calling.md) for exact shapes, curl/SDK examples, isolation, limits and verified coverage.

## Usage and cache signals

Codex app-server emits official token usage updates through `thread/tokenUsage/updated`. The proxy maps the latest turn usage into OpenAI-compatible response fields.

For Chat Completions, `usage` includes:

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `prompt_tokens_details.cached_tokens` from Codex `cachedInputTokens`
- `completion_tokens_details.reasoning_tokens` from Codex `reasoningOutputTokens`

For Responses, `usage` includes:

- `input_tokens`
- `output_tokens`
- `total_tokens`
- `input_tokens_details.cached_tokens` from Codex `cachedInputTokens`
- `output_tokens_details.reasoning_tokens` from Codex `reasoningOutputTokens`

Codex currently does not expose Claude-style prompt cache creation/write token counts through app-server. Treat cached and reasoning token details as upstream-reported accounting, not independently verified billing data.

## Transport

Only stdio is used. Codex WebSocket app-server transport is intentionally avoided because upstream documents it as experimental/unsupported.
