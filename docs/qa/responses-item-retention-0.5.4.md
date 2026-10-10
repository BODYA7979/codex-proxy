# Responses item retention — 0.5.4

The supplied n8n/Bifrost log reported HTTP 400 `item_reference_not_found`. Its 38 input items included four message references and 16 completed function-call/output pairs; the history was approximately 192 KiB. Original referenced message text and raw HTTP bodies were absent. The user confirmed a pause exceeding ten minutes, one proxy instance, and no need to assume a multi-replica routing failure.

The defect was coupling item-reference retention to the ten-minute worker/full-response cache. An SDK history containing opaque message IDs could no longer be replayed after an idle gap. Response-entry eviction also removed references, even when retaining the individual items would require much less memory. Both paths reproduced on 0.5.3 using synthetic data.

## Change

- Separate owner-scoped item storage from worker/full-response lifetime. Default idle retention is 24 hours, configurable through `CODEX_PROXY_RESPONSE_ITEM_TTL_MS`.
- Store each owner/item pair once, refreshing retained ancestors after a successful stored response. Full response expiry/eviction no longer deletes retained items.
- Bound the independent cache by 32 MiB of serialized key/item payload and 16,384 items. Evict least recently committed items under pressure. Full response storage retains its separate 32 MiB limit and existing TTL/capacity; live worker TTL is unchanged.
- Restore actual content and replay complete call/output history into a new worker when a worker has expired. Never discard unresolved context or repeat client tool execution to recover it.
- Retain owner isolation, missing-reference errors, and `store:false` behavior. Failed or nonstored responses do not refresh items.

## Evidence

- Added regression tests fail against the previous release for idle/history expiry and response eviction/deduplicated LRU retention.
- Unit tests verify actual content restoration, complete call/output replay after pending-state expiry, cross-owner rejection, item expiry, byte/count bounds, refresh/deduplication, oversized admission, clear, and nonstored responses.
- Exact `@ai-sdk/openai@4.0.20` JSON/SSE tests continue through the real installed app-server and local Bifrost after deliberately expiring completed-response histories and closing workers. Synthetic inference preserves the two-round tool cycle and content-array results; the fresh worker's inference request is checked for both earlier assistant texts, actual client results and the final answer.
- Production containers on linux/amd64 and linux/arm64 pass the SDK/two-round/SSE cycle on pinned Codex 0.162.0-alpha.2. After a shortened history TTL, `previous_response_id` fails as expected while item-reference replay succeeds with the original assistant context and results. The fixture distinguishes fresh-worker serialized history from live RPC outputs.
- Full suite with all caller/Responses/Bifrost integrations enabled: **201 passed, 0 failed, 0 skipped**. Type checking and diff checks pass.
- Private log/tool content was inspected locally only. No private workflow was run or sent to a live model. The supplied log does not contain the original assistant messages needed for an exact historical-content replay.

## Remaining limits

This is a bounded volatile cache, not durable OpenAI response storage. Restart or changing instances still invalidates IDs; after an upgrade, use a fresh conversation or resend inline content. Item TTL/byte/count exhaustion can still make old references unavailable. `previous_response_id` retains the existing ten-minute default independently. Clients requiring replay across restarts should use `store:false` with inline history, or retain original response items themselves.
