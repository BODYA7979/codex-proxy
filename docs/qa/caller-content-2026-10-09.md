# Caller assistant content compatibility — 0.4.11

Bifrost omits `content: null` when forwarding assistant messages containing tool calls. Caller request validation previously rejected those messages with HTTP 400 `invalid_request` / `Invalid messages`, before contacting Codex inference.

The validator now accepts omitted content only on assistant messages with a nonempty list of valid function calls (call ID, function name and string arguments). It continues rejecting omitted content on other roles and assistant messages with empty or malformed calls. Session ownership and complete tool-result batch checks are unchanged.

The regression fixture returns two parallel function calls without assistant text, then a subsequent function call, then the final answer. It exercises both explicit null content through actual Bifrost and omitted content through the direct proxy route, in JSON and SSE modes.

Verified on 2026-10-09:

- `npm test`: 143 passed, zero failures; two opt-in suites skipped.
- Real installed Codex CLI plus local Bifrost: 23 passed, zero failures, zero skips. Command: `CODEX_PROXY_CALLER_INTEGRATION=1 CODEX_PROXY_TEST_BIFROST_IMAGE=maximhq/bifrost:latest node --test dist/__tests__/caller.integration.test.js`.
- Packaged `linux/arm64` image: 31 passed, zero failures, zero skips.
- Packaged `linux/amd64` image: 31 passed, zero failures, zero skips.
- Both images report proxy version `0.4.11`, caller mode and Codex CLI `0.162.0-alpha.2`. Their actual image healthcheck passes on port 80.

Container tests ran with `--network none`, fixture credentials and `CODEX_PROXY_CALLER_INTEGRATION=1`, using `node --test dist/__tests__/caller.integration.test.js dist/__tests__/caller.test.js dist/__tests__/server.test.js`. Model inference used a deterministic local fixture; no paid model calls or live OpenAI inference checks were made.
