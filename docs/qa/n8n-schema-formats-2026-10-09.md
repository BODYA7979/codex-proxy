# n8n standard schema formats — 0.5.2

The supplied n8n Responses streaming log reported proxy HTTP 400 `invalid_tool_schema` before inference. Local reproduction compiled each of its 22 tool definitions: three failed because Ajv had no registered `uri`/`date-time` implementations. Ajv 7+ provides these standard formats through the separate `ajv-formats` package.

The shared compiler now registers `ajv-formats` in full validation mode for every dynamically supplied function/output schema. Validation remains enabled: invalid URI/date-time values and unknown custom formats still fail. There are no hardcoded n8n tool names, schemas, or model names. Adding or changing fields within the supported dialect does not require another proxy patch. Unknown dialects/keywords/formats, schema resource limits, and backend strict-decoding limits remain explicit compatibility boundaries.

Verification:

- All 22 tool schemas from the supplied log compile and the complete request normalizes locally after the fix. Private messages and credentials were not included in this check.
- Regression covers valid URI/date-time, malformed URI, invalid calendar date, missing time zone, model argument validation, and rejection of unknown custom formats.
- Full unit and real installed app-server integrations: **183 passed, 0 failed, 0 skipped**.
- Build and TypeScript type checks passed.
- Live `gpt-6.1-sol` cycle with a fresh synthetic URI/date-time schema and fixture values passed function calling, client result handling and SSE completion, both with `strict:false` and with omitted strict. Omitted-strict response ID: `resp_bb91db5586e0425eac9395c3714ae163`.
- Explicit `strict:true` on the synthetic URI schema was rejected by the upstream. Local format support does not override the backend's narrower strict-decoding subset; the proxy does not silently downgrade explicit strict requests.

Automatic approval review rejected transmitting the entire private tool catalog to the live external model service. The full catalog was therefore checked locally only; live testing used freshly authored synthetic schemas with no data or tools copied from that log. No actual n8n workflow was executed.
