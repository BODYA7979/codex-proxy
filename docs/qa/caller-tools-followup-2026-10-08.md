# Caller follow-up verification — 2026-10-08

Release 0.4.9 corrects permission scoping, conversation compaction, inference retry state and duplicate assistant text in caller tool loops.

## Findings and evidence

The deployed 0.4.8 service reported `tool_execution_mode: caller`. Local OpenCode history confirmed actual client `glob` and `grep` operations. A separate temporary-client test against that service read and edited its own file successfully, but repeated assistant text after tool continuations.

The reported ID failure was preceded by a `Codex app-server protocol error`; OpenCode retried its continuation shortly afterwards and then received `Unknown, expired or foreign tool_call_id`. The original upstream reason was hidden by 0.4.8's generic error handling. Attribution of that specific failure to compaction is not claimed without the server's original inference diagnostics.

Two compaction defects were nevertheless verified in the implementation: the custom provider identity prevented selection of OpenAI harness compaction, and the guard rejected `compaction` output unconditionally. A real app-server test demonstrates auto-compaction followed by successful caller inference when provider identity and dedicated non-operational compaction output are preserved.

## Fixes

- Repeated caller instructions explicitly scope proxy sandbox/working-directory/approval metadata to the proxy. Client capability comes from tools and results; user and client policies remain authoritative.
- Dedicated compaction keeps its trigger last and accepts exactly one opaque compaction item. Native/function tool execution remains forbidden in that path.
- Recoverable upstream errors leave the original turn alive for the harness's inference retry loop, which consumes the already-provided client result.
- Permanent failures retain bounded owner-isolated safe failure receipts. HTTP retries report the original reason with 409 and never resubmit client operations or expose a different client's state.
- Agent text is accumulated by item ID so delta/completion snapshots do not duplicate text across tool calls. Separate messages with equal text remain intact.
- `response_format` output schemas reach the actual `turn/start` RPC.
- Safe inference error codes/status/retryability are observable without logging credentials, prompts, arguments, results or upstream error bodies.

## Validation

`npm test`: 141 passed, zero failures; two opt-in integration suites skipped.

The complete local integration run with installed app-server 0.162.0-alpha.2, Bifrost and OpenCode reported 12 passing tests, zero failures/skips. It covers the existing JSON/SSE tool loops and isolation/cancellation plus transient model retry, permanent failure retry and real forced auto-compaction.

A live test with gpt-6.1-sol and real OpenCode explicitly described the proxy as read-only. OpenCode completed client-side glob, grep, read, apply_patch and verification read; the synthetic file changed from `CLIENT_OLD_VALUE` to `CLIENT_NEW_VALUE`. The final answer confirmed the client write, and no repeated assistant message was observed. Test directories were removed.

No environment changes are required beyond `CODEX_PROXY_TOOL_EXECUTION_MODE=caller`. Existing failed IDs cannot be revived by upgrading: after recreating the container, start a fresh user request rather than replaying the failed result batch. `/health` should report version 0.4.9 and caller mode.
