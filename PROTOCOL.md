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

`/v1/responses` accepts text input or a minimal input item array. It maps the final Codex turn to:

```json
{
  "object": "response",
  "status": "completed",
  "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "..." }] }]
}
```

Streaming emits minimal Responses-style event names:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`

`response.completed` reuses the same response id emitted by `response.created`. Text-only streams include both `text` and a compatibility `delta` alias on `response.output_text.done`.

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
