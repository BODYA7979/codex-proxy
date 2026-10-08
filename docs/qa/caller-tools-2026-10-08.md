# Caller tool execution verification — 2026-10-08

The implementation was verified in this checkout without modifying the running user services or OpenCode configuration. The temporary Bifrost container and test directories were removed by the harness.

## Verified runtime

- Node.js 22.17.1; dependencies installed using the repository lockfile.
- Installed Codex app-server: `0.162.0-alpha.2`.
- OpenCode: `1.18.33`.
- Bifrost: `maximhq/bifrost@sha256:65854fd1941ba8159f1f98cd69df380f6e8ac8cd374bde632c4e28f822a6f115`.
- Live model: `gpt-6.1-sol`; two HTTP requests returned 200, first with one external function call, second with an answer consuming the client's directory result.

## Reproducible checks

`npm test`: 137 passed, zero failures. One opt-in integration suite was skipped in this run. Existing hybrid, sticky sessions and synthetic structured-output regressions passed.

```sh
CODEX_PROXY_CALLER_INTEGRATION=1 \
CODEX_PROXY_TEST_BIFROST_IMAGE=maximhq/bifrost:latest \
CODEX_PROXY_TEST_OPENCODE=1 \
node --test dist/__tests__/caller.integration.test.js
```

The integration run reported nine passing tests (eight scenarios plus their parent suite), zero failures and zero skips. It used the real installed app-server with a deterministic local Responses fixture, a real isolated Bifrost Docker container and the installed OpenCode CLI.

Verified scenarios:

1. Direct JSON: mixed text plus two calls, tool error, subsequent call and final result.
2. Direct SSE: same cycle, stable stream IDs, indexed calls, JSON arguments and finish reasons.
3. Bifrost JSON: same complete cycle, including a foreign tenant's rejected continuation.
4. Bifrost SSE: same complete cycle and isolation check.
5. `required` selecting the second function, named choice, `none`, and JSON-schema final output.
6. Two simultaneous clients receiving separate results; duplicate/foreign IDs rejected; explicit cancellation and idle expiry.
7. Native `exec_command` model output rejected before delivery to app-server, with no marker file created; active-inference and startup disconnects followed by recovered capacity.
8. OpenCode received and executed `bash` (`pwd && ls`) in its temporary `opencode-client` directory through Bifrost, saw `client-only.txt`, returned the result, and received the final assistant answer.

A separate live upstream smoke used a `list_files` client function that read only a temporary external-client directory. The real model selected it under `tool_choice: required`, then consumed the returned file name under `auto`. The initial attempt with `gpt-5.4-mini` failed because that model was unavailable to this account; `gpt-6.1-sol` completed the cycle. This smoke consumes real model usage; the reproducible integration fixture above does not.

The final lifecycle includes linked official credentials (tested with synthetic credential refresh and cleanup), bounded caller capacity including closing workers, pending-result TTL, model/RPC timeouts, cancellation, process-exit handling and awaited shutdown cleanup. Unsupported Responses API caller requests are explicitly rejected with 400, rather than falling through to hybrid execution. `git diff --check` passed.

## Limits of the evidence

Live model access is account-specific. No caller Responses API support is claimed. Caller SSE buffers each inference before releasing validated events. Initial history uses the existing prompt adapter; in-flight tool results use genuine app-server RPC results and model function-call outputs.

The original `/app` sandbox incident remains unconfirmed: the expected local proxy logs were absent. These tests demonstrate the new execution boundary, rather than attributing that earlier incident.
