# Responses item replay and n8n AI SDK — 0.5.3

The supplied n8n/Bifrost Responses-stream log reported proxy HTTP 400 `unsupported_input_type`. It contained 95 input items, including 24 `{type:"item_reference",id:"msg_resp_..._0"}` references, 33 function calls/results, three text-array results, and 22 available tools. Raw prior response bodies and referenced assistant text were absent from the log. The user confirmed this was a new chat after 0.5.2.

Confirmed proxy defects:

- The Responses parser rejected native item references instead of resolving cached output items.
- It rejected text content-array function outputs.
- Pending-call integrity checks compared raw JSON argument strings, so SDK parse/stringify formatting changes could reject otherwise identical calls.

Fix:

- References resolve actual owner-scoped cached input/output items, supporting native `id` and legacy `item_id`. The item index follows retained lineage and is bounded/cleaned with existing state; it is cleared at shutdown and cannot expose foreign-owner content.
- Message IDs use the response ID and output index consistently across SSE and final objects, matching the replay form exposed by SDKs/gateways.
- Ordered text function outputs normalize through one shared converter for both caller continuation and native text replay. Unsupported media is explicitly rejected.
- JSON argument comparisons preserve actual values while allowing whitespace/property-order differences.
- Unknown/expired/foreign references fail with `item_reference_not_found`; no cached assistant text is fabricated or silently dropped. Inline historical content remains available for stateless replay.

Evidence:

- Exact `@ai-sdk/openai@4.0.20` provider replay reproduced the failure with newly authored synthetic data, directly and through the locally installed real Bifrost image.
- Corrected JSON and SSE cases passed through the exact SDK, actual Bifrost, real installed Codex app-server and deterministic local inference: parallel batch, text-array outputs, a second tool round, and full stored-item history replay into a new turn after completion.
- Full regression plus real app-server/Bifrost/SDK suites: **198 passed, 0 failed, 0 skipped**.
- Unit coverage includes owner isolation, TTL, ancestor retention, malformed/missing IDs, actual cached message content, function-item references, media rejection, JSON integrity and native replay text preservation.
- Entire supplied input normalized locally after seeding explicitly synthetic cached assistant contents for its opaque IDs: 95 messages, 24 resolved references, 22 tool schemas. This verifies the request's remaining shapes, not the missing original assistant text.
- Private log contents were never sent to a live external model. No actual n8n workflow/tool operation was executed.

Upgrade invalidates volatile reference and pending-call state. Start a fresh n8n conversation after container replacement; existing opaque IDs cannot be reconstructed without original inline messages. A fresh conversation can now replay stored references while its cache remains available. `store:false` clients must send inline items instead.
