# Responses API function calling

Both `/responses` and `/v1/responses` support external function calling through the same app-server dynamic-tool runtime used by Chat Completions. External functions execute on the client. The proxy returns native `function_call` items and resumes the running Codex turn when the client supplies matching `function_call_output` items.

## Root cause and architecture

The original error was an explicit HTTP 400 guard in `src/server/routes.ts`: `caller execution is supported only for Chat Completions; use /v1/chat/completions`. It ran before app-server execution, so neither n8n nor Bifrost generated that error. The old Responses types used Chat-style nested tools, serialized only text messages, and echoed `previous_response_id` without looking it up.

`src/responses/validation.ts` normalizes native Responses tools, choices, input and `text.format` to the existing shared request representation. `src/responses/http.ts` serializes native output items and typed SSE. `src/responses/state.ts` restores owner-scoped histories and controls continuation. The existing caller inference guard and runtime retain responsibility for tool registration, model validation, RPC correlation, cancellation and worker cleanup. JSON Schema validation is shared in `src/adapter/function-tools.ts`.

Modes:

- `caller`: only supplied external functions reach app-server. Existing caller isolation, permissions and native-tool suppression are retained.
- `hybrid` (default): Responses external functions use dedicated workers with native tool definitions retained. Native tools execute inside the proxy under its configured sandbox/approval policy; external functions still require client execution. These workers use isolated temporary homes and working directories and do not load user/project plugins or MCP configuration. Text-only hybrid requests retain the existing pooled/oneshot/sticky infrastructure.

Select the mode with `CODEX_PROXY_TOOL_EXECUTION_MODE`, top-level `tool_execution_mode`, or `codex_proxy.tool_execution_mode`. Pending turns must retain their mode. Chat Completions retains its existing hybrid operational bridge and caller execution behavior.

## Requests and output

Responses tools use `{type:"function", name, description, parameters, strict}`. This fork's previously accepted nested Chat format remains an alias. Tool names must be unique, match `[a-zA-Z0-9_-]{1,64}`, and number at most 128. Unsupported hosted/custom tool definitions return `unsupported_tool_type`.

Supported choices are `auto`, `none`, `required`, and `{type:"function",name:"get_weather"}`. `required` and named selection are verified at inference time, without fabricated arguments. In hybrid mode, `none` removes external functions while retaining native definitions. `parallel_tool_calls:false` is forwarded and enforced: multiple returned external calls produce an API error. An omitted preference preserves app-server model/transport defaults. If app-server disables parallel calls (for example Codex Responses Lite), a client preference cannot enable them; calls proceed sequentially. Calls have unique item IDs (`fc_...`) and correlation IDs (`call_...`); arguments remain JSON strings.

`instructions`, message arrays, images, `reasoning.effort`, `text.format` (`text`, `json_object`, `json_schema`), metadata, model and existing request extensions are accepted. The legacy `response_format` remains an alias; it cannot be combined with `text.format`. Function parameters and final structured answers are validated with Ajv. Invalid/unsupported schemas, including unknown schema keywords and unsupported custom formats/dialects, fail before worker startup. Schemas are limited to 256 KiB per function. Validation does not coerce values, insert defaults or remove properties. `strict:true` is forwarded to inference; schema-conforming output is enforced before tool calls reach the client. This is output validation, not a guarantee that every upstream implements OpenAI constrained decoding. Upstream rejections remain explicit errors.

Every emitted message and function call retains its relative output order. Tool-call JSON is never emitted as assistant text. Unknown function names, invalid arguments and incomplete calls fail closed.

## Continuation and replay

Send `previous_response_id` with exactly one `function_call_output` for every pending call. Supply string outputs, including JSON encoded as a string. The pending app-server RPCs receive these results and the original turn continues, including additional tool rounds.

Model and tool definitions can be omitted when the referenced response is stored; they are inherited. Explicit changes to model/catalog, execution mode, reasoning or text format during a pending turn are rejected, because its harness is already running. Omitted reasoning/text format retain the pending turn's settings. `tool_choice` can change each round. Top-level `instructions` apply to the current request only: resend instructions when desired; previous top-level instructions are not restored by `previous_response_id`.

Completed text responses also support chaining and forks: prior input/output is replayed into the next execution. Pending tool rounds cannot fork or accept results twice. Concurrent continuation returns 409. Live continuations must end with all pending outputs; submit additional user messages after the pending turn completes.

Stateless clients can resend complete ordered history: user messages, prior `function_call` items, corresponding outputs and subsequent assistant items. While a matching worker remains alive, the results resume its RPCs; otherwise complete paired history starts a fresh worker. With `store:false`, response history is not stored and `previous_response_id` cannot reference that response. Pending workers still retain the minimum state needed to resume tool RPCs until completion, cancellation or expiry; resend the catalog/model with stateless histories.

Stored state is volatile and bounded:

- TTL: `CODEX_PROXY_CALLER_TTL_MS` (default 10 minutes).
- Maximum entries: `8 × CODEX_PROXY_CALLER_MAX_SESSIONS` (default 256).
- Total cached history/catalog/execution payload: 32 MiB; per history: 1 MiB.
- Workers: existing caller session limit and independent idle TTL.
- Completed/consumed entries may be evicted under pressure. Active pending entries are retained until expiry; exhausted capacity returns 429.
- Owner identity includes Authorization, `X-Codex-Proxy-Client-Id`, and OpenAI `user`. Resend the same identity on continuation. Shared credentials require distinct client IDs for tenant isolation.
- Restart, expiry or eviction makes response references invalid (`previous_response_not_found`); full explicit replay remains available. No prompt/output history is persisted to disk by the new response-reference cache. App-server itself may maintain temporary harness state, deleted during worker cleanup.

## Streaming

All events include monotonic `sequence_number`. Lifecycle: `response.created`, `response.in_progress`, per-item events, then `response.completed`. Failures after stream startup emit `response.failed`, without a successful completion.

Messages use `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`. Functions use `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done` (including `name`), `response.output_item.done`. IDs and output indexes are stable throughout a stream.

Function-enabled requests buffer model output for validation, then emit complete argument deltas and item lifecycle events. They do not provide real-time token-by-token argument streaming. Text-only hybrid requests retain live text deltas. Keepalive comments continue while waiting. Disconnects abort execution; pending calls whose response cannot be delivered are cancelled. Active execution timeouts use the existing timeout settings; RPC wait time is paused while waiting for client results.

Schemas follow the official [function calling guide](https://developers.openai.com/api/docs/guides/function-calling) and [Responses streaming reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).

## curl example

Choose an available model from `/v1/models`, then set `MODEL` to its ID. This example deliberately returns fixture weather from the client.

```sh
BASE_URL=http://127.0.0.1:3466
MODEL='<available-model-id>'
first=$(jq -n --arg model "$MODEL" '{
  model:$model, input:"What is the weather in Kyiv?", tool_execution_mode:"caller",
  tools:[{type:"function", name:"get_weather", description:"Get weather", strict:true,
    parameters:{type:"object", properties:{city:{type:"string"}}, required:["city"], additionalProperties:false}}],
  tool_choice:{type:"function", name:"get_weather"}
}' | curl -fsS "$BASE_URL/v1/responses" -H 'Content-Type: application/json' -d @-)

printf '%s' "$first" | jq -c --arg model "$MODEL" '{
  model:$model, previous_response_id:.id, tool_execution_mode:"caller", tool_choice:"none", stream:true,
  input:[.output[] | select(.type=="function_call") |
    {type:"function_call_output", call_id:.call_id, output:"{\"temperature\":12,\"condition\":\"cloudy\",\"fixture\":true}"}]
}' | curl -NfsS "$BASE_URL/v1/responses" -H 'Content-Type: application/json' -d @-
```

## Official JavaScript SDK example

See the runnable [SDK example](../examples/responses-function-calling.mjs). It uses `client.responses.create`, handles repeated function rounds, executes a weather fixture on the client and consumes the final SSE response. Use a real client weather service in place of the fixture. The explicit-replay alternative is to keep an input array, append `response.output` and each `function_call_output`, and send that array without `previous_response_id`.

```sh
CODEX_PROXY_MODEL='<available-model-id>' node examples/responses-function-calling.mjs
```

## Tests and limits

```sh
npm run build
npx tsc --noEmit
npm test
npm run test:responses     # official SDK + real installed app-server + deterministic inference
npm run test:caller        # existing Chat Completions real app-server regressions
npm run test:integration   # both integration suites
```

The app-server integration tests require a compatible authenticated Codex installation (baseline `0.162.0-alpha.2` or newer); local deterministic inference does not make paid model calls. JSON, SSE, single/parallel calls, two tool rounds, stateless replay, instructions, modes, schema errors, choices, isolation, duplicate results, disconnects and timeouts are covered. A separate authenticated live-model smoke test verified the complete SDK weather cycle. See [verification](qa/responses-function-calling-2026-10-09.md).

No accessible n8n instance was found locally. The proxy-origin rejection is removed and its request sequence is verified with the official SDK. Actual n8n node/workflow compatibility remains unverified; this does not establish a limitation in n8n.

This is not complete OpenAI platform parity: no durable response retrieval/deletion API, Conversations, background tasks, hosted tools, item-reference resolution, multimodal function outputs, or encrypted reasoning replay. Unsupported input types/options, reasoning summary requests and text verbosity return explicit errors. Tool-enabled requests cannot use sticky worker keys; they use response/call IDs. Sampling/length knobs retain this fork's pre-existing limitations; Codex controls sampling and active-turn output budgets. The documented JSON Schema dialect is draft-07 with the standard formats provided by `ajv-formats` (URI, date-time, email, UUID and others), without external remote references; unknown custom formats and other dialects are rejected. New fields/nested schemas are compiled dynamically. Upstream strict decoding can support a narrower schema subset than local validation; explicit strict requests retain their semantics and upstream rejection is surfaced. There is no server-side execution of external functions.

Standard format support follows [Ajv format validation](https://ajv.js.org/guide/formats.html).
