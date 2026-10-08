# Tools executed by OpenCode

Enable caller mode for an OpenCode → Bifrost → Codex Proxy → Codex app-server connection:

```sh
CODEX_PROXY_TOOL_EXECUTION_MODE=caller CODEX_PROXY_DEFAULT_MODEL=gpt-6.1-sol npm start
```

`hybrid` remains the default. A direct Chat Completions request can instead select `"tool_execution_mode":"caller"` at the top level or inside `codex_proxy`. Conflicting/unknown values are rejected. Bifrost can remove proxy-specific fields, so use the environment setting behind a gateway.

Caller mode applies to `/v1/chat/completions` and `/chat/completions`. `/v1/responses` rejects caller mode with HTTP 400 instead of silently allowing native operations. Its existing implementation remains available in hybrid mode; caller execution for that endpoint is a later phase. Caller mode uses dedicated processes, regardless of the hybrid runtime setting, and does not reuse sticky-session workers.

## Runtime requirement

The supported baseline is **Codex app-server 0.162.0-alpha.2**, the installed version whose generated experimental schema and real RPC flow were verified. Model IDs must be available to the authenticated account; the live smoke verified `gpt-6.1-sol`. A missing model is an upstream error, not a caller tool failure. Earlier versions are rejected rather than falling back to prompt JSON. Use this version or a newer compatible release; newer incompatible protocol behavior fails closed.

Inspect your binary with:

```sh
codex --version
codex app-server generate-json-schema --experimental --out /tmp/codex-schema
```

The required capabilities are `initialize.capabilities.experimentalApi`, `thread/start.dynamicTools` with function specs containing `type`, `name`, `description`, `inputSchema`, and the `item/tool/call` / `DynamicToolCallResponse` flow. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes the experimental tool registration and result protocol.

The Dockerfile pins the supported Codex 0.162.0-alpha.2 baseline for both modes. You can also select a newer compatible version with the build argument:

```sh
docker compose build --build-arg CODEX_CLI_VERSION=0.162.0-alpha.2
```

Add `CODEX_PROXY_TOOL_EXECUTION_MODE: caller` to the proxy service environment. Authenticate with `codex login` as usual. Caller workers use a private temporary `CODEX_HOME` and working directory, linking only the official CLI's `auth.json`. User/project MCP, plugin, hook and skill configuration is not loaded. The original credential store remains managed by the official CLI, including token refresh; credentials are never copied into a disposable snapshot. Links and temporary state are removed when the session closes; the original login is retained. A keyring-only login is not currently supported by this isolated credential setup; authenticate the service using file-based Codex credentials. No client tool arguments are executed in this directory.

## Why the execution boundary is an adapter

The inspected app-server RPC schema supports structured dynamic calls but has no general caller-only tool allowlist or Chat Completions `tool_choice` field. Turning off shell features alone would leave other built-in operations available.

Caller workers therefore use a loopback Responses inference adapter as their model provider. It replaces the outgoing tool definitions with client functions, applies `auto`, `none`, `required`, or the named choice to the upstream inference request, and validates the complete upstream SSE response before releasing it to app-server. Native/custom/hosted tool calls, unknown function names, invalid JSON argument objects, incomplete inference responses, and violations of the choice are rejected. Internal aliases prevent collisions with Codex tool names; the OpenAI response retains the client's exact original name.

Codex registers these functions using `dynamicTools` and requests their results through `item/tool/call`. The proxy never invokes their handlers. Structured calls come from model function-call items, not JSON embedded in assistant prose. An attempted native shell item is rejected before app-server receives it; widening the proxy sandbox is unnecessary.

The inference adapter forwards authentication supplied by the official app-server to `https://chatgpt.com/backend-api/codex/responses`. `CODEX_PROXY_CALLER_UPSTREAM` can select an administrator-controlled compatible Responses endpoint (including a local deterministic fixture). It is not a per-request field. App-server HTTP transport is forced; WebSocket inference is disabled.

## OpenCode configuration

Use the OpenAI-compatible provider so OpenCode uses Chat Completions. For a direct connection:

```json
{
  "provider": {
    "codex-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Codex Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:3466/v1",
        "apiKey": "local-placeholder"
      },
      "models": {
        "gpt-6.1-sol": { "name": "Codex gpt-6.1-sol" }
      }
    }
  }
}
```

Select `codex-proxy/gpt-6.1-sol`. OpenCode supplies its function definitions and executes `bash`, file reads and edits in its own working directory. The placeholder is only for clients that require a key; the proxy itself still needs official Codex authentication.

## Bifrost configuration

For a dedicated gateway, configure the OpenAI provider with the proxy as its base URL. **Do not append `/v1` to Bifrost's provider `base_url`: Bifrost adds it.** OpenCode's URL still ends in `/v1`.

```json
{
  "client": { "enable_logging": false },
  "providers": {
    "openai": {
      "keys": [
        {
          "name": "codex-proxy",
          "value": "local-placeholder",
          "models": ["gpt-6.1-sol"],
          "weight": 1
        }
      ],
      "network_config": {
        "base_url": "http://host.docker.internal:3466",
        "max_retries": 0
      }
    }
  },
  "config_store": { "enabled": false },
  "logs_store": { "enabled": false }
}
```

`host.docker.internal` is appropriate when Bifrost runs in Docker and the proxy runs on the host. For the same Compose network, use `http://codex-proxy:3466`; for native Bifrost use `http://127.0.0.1:3466`. If the gateway also serves real OpenAI, use a separate custom OpenAI-compatible provider instead of replacing its existing OpenAI provider. See [Bifrost's provider configuration](https://docs.getbifrost.ai/deployment-guides/config-json/providers).

In OpenCode, change `baseURL` to `http://127.0.0.1:8080/v1` and register the model as `openai/gpt-6.1-sol` under your gateway provider. Select e.g. `bifrost/openai/gpt-6.1-sol`. Disable gateway retries/caching/failover for pending tool continuations: automatic replay after an interrupted request can create duplicate client operations or consume a continuation twice.

## Returning results and session lifecycle

Each response with calls has `finish_reason: "tool_calls"` and `message.tool_calls`, or indexed `delta.tool_calls` in SSE. Text accompanying calls is retained. IDs are random, stable within a call, and independent from internal app-server IDs. Several calls can be returned together, including when the harness requests their results sequentially.

Append the assistant message and exactly one `role: "tool"` result for each pending `tool_call_id` to the next Chat Completions request. Keep the model and complete tool definitions unchanged. The results are returned to the original app-server RPCs; subsequent inference receives genuine `function_call_output` items. The same running turn can request further tools. Standard Chat Completions has no separate error-result flag: put an execution error in the tool message content so the model can retry or explain it.

Correlation is isolated by a hash of the forwarded Authorization header, optional `X-Codex-Proxy-Client-Id`, and OpenAI `user` field. A shared gateway credential is not a distinct client identity: forward a stable distinct `user` or client-ID for each tenant. Without a client identifier, unguessable call IDs act as bearer capabilities; do not share transcripts between clients. This is correlation, not proxy authentication; retain the authenticated gateway described in the main README for remote access.

| Setting | Default | Purpose |
| --- | --- | --- |
| `CODEX_PROXY_TOOL_EXECUTION_MODE` | `hybrid` | Default Chat Completions tool mode |
| `CODEX_PROXY_CALLER_TTL_MS` | `600000` | Idle lifetime while waiting for client tool results |
| `CODEX_PROXY_CALLER_MAX_SESSIONS` | `32` | Maximum dedicated caller workers, including active requests |
| `CODEX_PROXY_TIMEOUT_MS` | `120000` | Active model/RPC turn timeout; paused while waiting for caller results |
| `CODEX_PROXY_CALLER_UPSTREAM` | Codex ChatGPT Responses endpoint | Model endpoint behind the execution guard |

Unknown, expired, duplicated, incomplete or foreign results return 400. Capacity exhaustion returns 429. A simultaneous continuation can return 409 or 400 after the first request has claimed its IDs. Disconnecting an active HTTP request cancels its worker and in-flight inference. Completed responses leave pending calls alive only until their TTL. Failed turns and shutdown close the worker, listener and temporary state. State is in memory: restart invalidates pending call IDs. After a crash, OS temporary directories may need routine cleanup; no durable/resumable caller sessions are claimed.

Cancel an abandoned batch by calling the proxy directly with the same identity used by the gateway:

```http
POST /v1/caller/cancel
Content-Type: application/json
Authorization: Bearer local-placeholder

{"user":"tenant-a","tool_call_ids":["call_..."]}
```

Cancelling any call closes its whole pending batch/session. Use the proxy's direct port for this endpoint; it is not a Bifrost inference route.

## Diagnostics, tests and limits

`/health` reports the configured mode; responses carry `X-Codex-Proxy-Tool-Execution-Mode`. With `CODEX_PROXY_DEBUG=1` or `CODEX_PROXY_TRACE=1`, caller events contain request ID, mode, received tool count, returned call count, or failure kind. Raw caller JSON-RPC, prompts, arguments, tool results and subprocess stderr are suppressed. Gateway logging settings are separate; the example disables gateway content logs.

Run regression tests with `npm test`. Run the real installed app-server against a deterministic local inference server with `npm run test:caller`. No paid model calls are made by this fixture.

To also exercise a real Bifrost Docker image and installed OpenCode:

```sh
CODEX_PROXY_TEST_BIFROST_IMAGE=maximhq/bifrost:latest \
CODEX_PROXY_TEST_OPENCODE=1 npm run test:caller
```

The test creates a temporary gateway container, client working directory, isolated OpenCode configuration and credentials-free model fixture. It covers JSON/SSE, mixed text and calls, parallel and subsequent calls, error results, choice semantics, structured output, client isolation, cancellation, TTL and a forbidden native-shell response. The OpenCode check executes only `pwd && ls` in the temporary client directory. Hybrid and legacy structured-output regressions remain in the normal suite.

Current limits: function tools with JSON object arguments only; complete result batches only; immutable model/tool catalog during a pending cycle; initial history still uses the proxy's existing prompt adapter. Caller SSE emits real OpenAI tool-call/text chunks and keepalive comments, but buffers each upstream inference until validation completes, so text tokens are delivered in a burst. A future app-server-native tool allowlist and explicit tool-choice API could remove the inference adapter and this buffering requirement.

The reported historical `/app` sandbox attempt is not confirmed by available local proxy logs. Absence of an OpenCode tool event alone does not identify the executing process; correlate original proxy/app-server logs by time/request ID before attributing that incident.
