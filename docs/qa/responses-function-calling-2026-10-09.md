# Responses function calling verification — 2026-10-09

## Baseline and confirmed defect

The initial checkout rejected Responses caller mode in the HTTP route with `unsupported_tool_execution_mode`, before contacting Codex. The existing regression test explicitly expected this rejection. Responses serialization only produced messages and response references were not looked up. Before changes, the unrestricted baseline suite passed 143 tests with 2 optional integrations skipped. Inside the restricted workspace, the two local HTTP tests failed with `listen EPERM`; those were environment restrictions.

## Validation

- Final TypeScript build (`npm run build`) and type checking (`npx tsc --noEmit`) passed.
- Final full suite with both integration flags enabled: **180 passed, 0 failed, 0 skipped**. This includes all existing regression tests and both real app-server suites.
- `git diff --check` and SDK example syntax validation passed.
- Official OpenAI JavaScript SDK against local HTTP: single/parallel native output items, sequential rounds, previous-response continuation, explicit replay, ordered SSE/argument reconstruction, text, instructions and failures.
- Real installed Codex `0.162.0-alpha.17.2` app-server with deterministic inference: both Responses and existing Chat Completions integrations pass. Includes hybrid native definitions, interleaved text/calls, changed instructions, stateless worker replay, disconnects and active timeouts. No paid inference in these integration fixtures.
- Authenticated live Codex model (`gpt-5.5`), official SDK: one `get_weather` call for Kyiv; client returned fixture temperature 12 C; streamed final answer used the returned temperature and emitted `response.completed`. Response ID: `resp_32f783a21c4f482bb0aeb946868c4f68`.
- The live run revealed that Codex may emit completed items in `response.output_item.done` but leave the summary response's `output` empty. The adapter now retains those items; a regression covers this shape.
- Installed Codex alpha patch versions have an extra numeric prerelease component. The pre-existing version gate rejected that component; coverage now accepts the verified `alpha.17.2` version while retaining the minimum baseline.

## Not executed / remaining verification

No local running n8n container or supplied workflow instance was available. An actual n8n end-to-end workflow was not executed and n8n compatibility is not claimed. The original error is conclusively proxy-origin. Optional Bifrost/OpenCode end-to-end integrations were not enabled, and no Docker image was built/published. Core image configuration is unchanged; Ajv is a production dependency and OpenAI SDK a development dependency.

At initial implementation verification, changes were local and uncommitted. Subsequent publication was explicitly requested; the release version is 0.5.0.
