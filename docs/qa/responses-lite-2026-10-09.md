# Codex Responses Lite compatibility — 0.5.1

An n8n Responses request still failed after updating to 0.5.0. The supplied gateway log identified model `gpt-6.1-sol`, request type `responses`, and `max_output_tokens:16`. It did not contain raw request/response bodies or the actual upstream rejection reason.

A local reproduction using the authenticated Codex installation and synthetic input returned upstream HTTP 400, code `unsupported_value`, parameter `parallel_tool_calls`, message: `X-OpenAI-Internal-Codex-Responses-Lite requires parallel_tool_calls to be false.` The same request against `gpt-5.5` succeeded.

Root cause: the 0.5.0 inference adapter unconditionally injected `parallel_tool_calls:true` when the client omitted the option, overwriting app-server's model-specific `false`. The adapter now preserves backend defaults and false restrictions. Explicit client false remains enforced. Explicit client true cannot override backend false. No model name is hardcoded and no failed inference is retried with changed semantics.

Upstream diagnostics now read at most 8 KiB and disclose only allowlisted error codes and parameter names. Raw error bodies/messages, credentials, prompts and arguments remain suppressed. HTTP failure mapping and transient retry policy are preserved.

Verification:

- Full unit and installed app-server integration suite: **182 passed, 0 failed, 0 skipped**.
- TypeScript build/type checking and diff checks passed.
- Reproduced Responses request returns HTTP 200 after the fix on both `gpt-6.1-sol` and `gpt-5.5`.
- Live `gpt-6.1-sol` SDK cycle: one `get_weather` function call for Kyiv, client fixture temperature 12 C, completed streamed answer using that result. Response ID `resp_8a0efa568b3b42538ba97fbe75c4c013`.
- Regression tests cover omitted preference, backend false, explicit client true/false, forbidden parallel batches, and privacy-preserving HTTP error diagnostics.

An actual n8n workflow was not executed locally. The upstream failure was reproduced and resolved with the model/request shape from the supplied log. Container update invalidates volatile response/call references; start a fresh request after upgrading.
