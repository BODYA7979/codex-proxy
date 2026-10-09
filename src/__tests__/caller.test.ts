import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { CallerInference } from "../caller/inference.js";
import { validateCallerRequest, supportsCallerVersion } from "../caller/runtime.js";
import { requestedFunctionTool, chatMessagesToPrompt } from "../adapter/openai-to-codex.js";
import { callerMode } from "../caller/http.js";
import { CONFIG } from "../server/config.js";
import { parseConfig } from "../server/config.js";
import type { ChatCompletionRequest } from "../types/openai.js";

const tools: NonNullable<ChatCompletionRequest["tools"]> = [
  { type: "function", function: { name: "bash", description: "Run a command in the client directory", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];
const request: ChatCompletionRequest = { messages: [{ role: "user", content: "Show files in the current directory" }], tools };
function stream(output: Record<string, unknown>[]): string {
  const response = { id: "resp_test", object: "response", status: "completed", model: "gpt-5.5", output, usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
  return output.map((item, output_index) => `data: ${JSON.stringify({ type: "response.output_item.done", item, output_index })}\n\n`).join("") + `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
}
const call = (name = "caller_tool_1", call_id = "model_call_1", args = '{"path":"README.md"}') => ({ id: `fc_${call_id}`, type: "function_call", call_id, name, arguments: args, status: "completed" });

test("caller config defaults to hybrid and validates request overrides", () => {
  assert.equal(parseConfig({}).toolExecutionMode, "hybrid");
  assert.equal(parseConfig({ CODEX_PROXY_TOOL_EXECUTION_MODE: "caller" }).toolExecutionMode, "caller");
  assert.throws(() => parseConfig({ CODEX_PROXY_TOOL_EXECUTION_MODE: "carrer" }), /must be caller or hybrid/);
  assert.equal(callerMode({ ...request, tool_execution_mode: "caller" }), "caller");
  assert.equal(callerMode({ ...request, tool_execution_mode: "caller", codex_proxy: { tool_execution_mode: "hybrid" } }), "invalid");
  assert.throws(() => validateCallerRequest({ ...request, tool_choice: { type: "function", function: { name: "missing" } } }));
  assert.throws(() => validateCallerRequest({ ...request, tools: [], tool_choice: "required" }));
});

test("caller accepts omitted assistant content only with valid function tool calls", () => {
  const toolCall = { id: "call_history", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } };
  const validate = (message: object) => validateCallerRequest({ ...request, messages: [message] } as ChatCompletionRequest);
  assert.doesNotThrow(() => validate({ role: "assistant", tool_calls: [toolCall] }));
  assert.doesNotThrow(() => validate({ role: "assistant", content: null, tool_calls: [toolCall] }));
  assert.doesNotThrow(() => validate({ role: "assistant", tool_calls: [toolCall, { ...toolCall, id: "call_parallel" }] }));
  for (const message of [
    { role: "assistant" }, { role: "assistant", tool_calls: [] }, { role: "assistant", tool_calls: {} },
    { role: "user", tool_calls: [toolCall] }, { role: "system", tool_calls: [toolCall] },
    { role: "tool", tool_call_id: "call_history" },
    { role: "assistant", content: 42, tool_calls: [toolCall] },
    ...[null, {}, { ...toolCall, type: "custom" }, { ...toolCall, id: "" },
      { ...toolCall, function: { name: "read", arguments: {} } },
      { ...toolCall, function: { arguments: "{}" } }].map(call => ({ role: "assistant", tool_calls: [call] })),
  ]) assert.throws(() => validate(message), /Invalid messages/);
});

test("inference boundary removes all native tools and honors all tool_choice values", () => {
  const adapter = new CallerInference(tools, "https://example.invalid", () => {}, () => {});
  const input = { tools: [{ type: "custom", name: "apply_patch" }, { type: "function", name: "exec_command" }], input: [{ type: "additional_tools", tools: [] }, { type: "message", role: "user", content: "list files" }] };
  adapter.setChoice("required");
  const converted = adapter.rewriteRequest(input);
  assert.equal(converted.tool_choice, "required");
  assert.deepEqual((converted.tools as Array<{ name: string }>).map(tool => tool.name), ["caller_tool_0", "caller_tool_1"]);
  assert.equal((converted.input as unknown[]).length, 2);
  assert.equal(adapter.validateResponse(stream([call()]))[0].name, "read"); // required chooses second tool
  assert.throws(() => adapter.validateResponse(stream([])), /tool_choice/);
  adapter.setChoice({ type: "function", function: { name: "bash" } });
  assert.deepEqual(adapter.rewriteRequest(input).tool_choice, { type: "function", name: "caller_tool_0" });
  assert.throws(() => adapter.validateResponse(stream([call()])), /tool_choice/);
  adapter.setChoice("none");
  assert.deepEqual(adapter.rewriteRequest(input).tools, []);
  assert.throws(() => adapter.validateResponse(stream([call()])), /allowlisted/);
  adapter.setChoice("auto");
  assert.deepEqual(adapter.validateResponse(stream([])), []);
  assert.equal(adapter.validateResponse(stream([call(), call("caller_tool_0", "model_call_2", '{"command":"ls"}')])).length, 2);
  assert.throws(() => adapter.validateResponse(stream([call("exec_command")])), /allowlisted/);
  assert.throws(() => adapter.validateResponse(stream([{ type: "custom_tool_call", name: "apply_patch" }])), /forbidden/);
  assert.throws(() => adapter.validateResponse(stream([call("caller_tool_0", "x", "broken")])), /JSON/);
  assert.throws(() => adapter.validateResponse("data: {}\n\n"), /Incomplete/);
});

test("JSON object mode preserves arbitrary fields and rejects invalid final answers", () => {
  const adapter = new CallerInference(tools, "https://example.invalid", () => {}, () => {});
  adapter.setResponseFormat({ type: "json_object" });
  const input = adapter.rewriteRequest({ input: [{ type: "message", role: "user", content: "Extract facts" }] }).input as any[];
  assert.match(input.at(-1).content[0].text, /Return ONLY a valid JSON object/);
  assert.match(input.at(-1).content[0].text, /Tool calls may precede the final answer/);
  assert.doesNotThrow(() => adapter.validateFinalText(' {"facts":[{"text":"fact","tags":[]}],"entities":[]} '));
  assert.doesNotThrow(() => adapter.validateFinalText('{}'));
  // Tool segments remain executable; only the completed final answer is JSON.
  assert.equal(adapter.validateResponse(stream([call()]))[0].name, "read");
  for (const invalid of ['[{"fact":"array"}]', 'null', 'true', '42', '"text"', '', '```json\n{}\n```', '{broken', '{} {}']) {
    assert.throws(() => adapter.validateFinalText(invalid), { code: "caller_invalid_json_object", message: "Caller final answer must be a valid JSON object" });
  }
  adapter.setResponseFormat({ type: "json_schema", json_schema: { schema: { type: "object" } } });
  assert.doesNotThrow(() => adapter.validateFinalText("Unrestricted by JSON object validation"));
  adapter.setResponseFormat(undefined);
  assert.doesNotThrow(() => adapter.validateFinalText("Ordinary text"));
});

test("HTTP inference guard forwards auth without forwarding native tools or leaking forbidden SSE", async () => {
  let received: Record<string, unknown> = {};
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, "Bearer test-credential");
    res.writeHead(200, { "content-type": "text/event-stream" }).end(stream([call("exec_command")]));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  let failed = false;
  const adapter = new CallerInference(tools, `http://127.0.0.1:${port}`, () => assert.fail("must not publish forbidden calls"), () => { failed = true; });
  try {
    const url = await adapter.start();
    const result = await fetch(`${url}/responses`, { method: "POST", headers: { authorization: "Bearer test-credential" }, body: JSON.stringify({ tools: [{ name: "exec_command" }] }) });
    assert.equal(result.status, 502);
    assert.equal(failed, true);
    assert.doesNotMatch(await result.text(), /exec_command/);
    assert.deepEqual((received.tools as Array<{ name: string }>).map(tool => tool.name), ["caller_tool_0", "caller_tool_1"]);
  } finally { adapter.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("hybrid required leaves tool selection to the model and retains synthetic schema output", () => {
  assert.equal(requestedFunctionTool({ tools, tool_choice: "required" }), null);
  assert.equal(requestedFunctionTool({ tools: [{ type: "function", function: { name: "Decision" } }], tool_choice: "required" })?.function.name, "Decision");
  const { prompt } = chatMessagesToPrompt([{ role: "assistant", content: "Checking", tool_calls: [{ id: "call_previous", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] }, { role: "tool", tool_call_id: "call_previous", content: "client.txt" }]);
  assert.match(prompt, /previous_tool_calls/);
  assert.match(prompt, /call_previous/);
});

test("caller version gate honors the verified protocol baseline", () => {
  for (const version of ["0.162.0-alpha.2", "0.162.0-alpha.10", "0.162.0", "0.163.0", "1.0.0"]) assert.equal(supportsCallerVersion(`codex-cli ${version}`), true);
  for (const version of ["0.160.0", "0.162.0-alpha.1", "unknown"]) assert.equal(supportsCallerVersion(`codex-cli ${version}`), false);
});

test("isolated caller credentials preserve official token refresh and cleanup retains original login", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { linkCallerCredentials } = await import("../caller/credentials.js");
  const directory = await mkdtemp(join(tmpdir(), "caller-auth-test-"));
  try {
    const source = join(directory, "source"), caller = join(directory, "caller");
    await mkdir(source); await mkdir(caller);
    await writeFile(join(source, "auth.json"), '{"fixture":"old"}', { mode: 0o600 });
    await linkCallerCredentials(source, caller);
    // Match the official file store's in-place save through its isolated path.
    await writeFile(join(caller, "auth.json"), '{"fixture":"refreshed"}');
    assert.equal(await readFile(join(source, "auth.json"), "utf8"), '{"fixture":"refreshed"}');
    await rm(caller, { recursive: true, force: true });
    assert.equal(await readFile(join(source, "auth.json"), "utf8"), '{"fixture":"refreshed"}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Responses API rejects caller mode instead of bypassing the execution boundary", async () => {
  const { createApp } = await import("../server/index.js");
  const previous = CONFIG.toolExecutionMode;
  const api = createServer(createApp());
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const url = `http://127.0.0.1:${(api.address() as { port: number }).port}/v1/responses`;
  try {
    CONFIG.toolExecutionMode = "caller";
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Read a file" }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error.code, "unsupported_tool_execution_mode");
    CONFIG.toolExecutionMode = "hybrid";
    const explicit = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Read a file", codex_proxy: { tool_execution_mode: "caller" } }) });
    assert.equal(explicit.status, 400);
  } finally { CONFIG.toolExecutionMode = previous; api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
});

test("caller permissions stay scoped to the proxy while client operations depend on tools/results", () => {
  const adapter = new CallerInference(tools, "https://example.invalid", () => {}, () => {});
  const original = { tools: [], input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "The proxy filesystem sandbox is read-only" }] }, { type: "message", role: "user", content: "Edit the client file" }] };
  const converted = adapter.rewriteRequest(original);
  const input = converted.input as any[];
  assert.deepEqual(input[0], original.input[0]);
  assert.equal(input.at(-1).role, "developer");
  const policy = input.at(-1).content[0].text;
  assert.match(policy, /ONLY the proxy\/app-server environment/);
  assert.match(policy, /supplied tools and their actual results/);
  assert.match(policy, /Do not declare the client read-only/);
  assert.match(policy, /specific failed client operation/);
});

test("compaction is accepted only for app-server's dedicated trigger and cannot execute tools", () => {
  const adapter = new CallerInference(tools, "https://example.invalid", () => {}, () => {});
  adapter.setChoice("required");
  adapter.setResponseFormat({ type: "json_object" });
  const converted = adapter.rewriteRequest({ input: [{ type: "message", role: "user", content: "History" }, { type: "compaction_trigger" }] });
  assert.equal(converted.tool_choice, "auto");
  assert.equal((converted.input as any[]).at(-1).type, "compaction_trigger");
  assert.doesNotMatch(JSON.stringify(converted.input), /Return ONLY a valid JSON object/);
  const compact = stream([{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-fixture" }]);
  assert.deepEqual(adapter.validateResponse(compact, true), []);
  assert.throws(() => adapter.validateResponse(compact), /forbidden/);
  assert.throws(() => adapter.validateResponse(stream([call()]), true), /non-compaction/);
  assert.throws(() => adapter.validateResponse(stream([{ type: "compaction", encrypted_content: "" }]), true), /encrypted/);
});
