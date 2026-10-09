import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import OpenAI from "openai";
import { ResponseState } from "../responses/state.js";
import { responsesToChat, normalizeResponsesTools, normalizeInput } from "../responses/validation.js";
import { handleResponsesRequest, RESPONSE_STATE, emitResponseItem } from "../responses/http.js";
import { CALLER_RUNTIME } from "../caller/runtime.js";
import { CallerInference, CallerInferenceError } from "../caller/inference.js";
import type { ResponseRequest, ResponseOutputFunctionCall, ChatCompletionRequest } from "../types/openai.js";

const tools: NonNullable<ResponseRequest["tools"]> = [{ type: "function", name: "get_weather", description: "Weather", strict: true, parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } }];
const body: ResponseRequest = { model: "gpt-5.5", input: "Weather?", tools };
const functionCall = (id = "call_1"): ResponseOutputFunctionCall => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "get_weather", arguments: '{"city":"Kyiv"}', status: "completed" });
const output = (id = "call_1") => ({ type: "function_call_output" as const, call_id: id, output: "12 C" });
const sse = (items: object[]) => `data: ${JSON.stringify({ type: "response.completed", response: { output: items } })}\n\n`;
const result = (text = "Done") => ({ text, turnId: "fixture", threadId: "fixture", finishReason: "stop" as const, usage: null, durationMs: null });

function state(now = Date.now) { return new ResponseState(() => ({ ttl: 100, entries: 3, bytes: 10000, historyBytes: 5000 }), now); }

test("Responses normalizes native/legacy tools, instructions, multiple messages, reasoning and text.format", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "Weather?" }] }, { role: "assistant", content: "Checking" }];
  const chat = responsesToChat({ ...body, instructions: "Answer briefly", reasoning: { effort: "low" }, input, tool_choice: { type: "function", name: "get_weather" }, parallel_tool_calls: false, text: { format: { type: "json_object" } } }, input);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "get_weather" } });
  assert.equal(chat.messages[0].content, "Answer briefly"); assert.equal(chat.messages.length, 3);
  assert.equal(chat.reasoning_effort, "low"); assert.equal(chat.parallel_tool_calls, false);
  assert.deepEqual(chat.response_format, { type: "json_object" });
  assert.deepEqual(normalizeResponsesTools({ ...body, tools: chat.tools }), chat.tools);
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  assert.deepEqual(responsesToChat({ ...body, text: { format: { type: "json_schema", name: "answer", schema, strict: true } } }, normalizeInput(body.input)).response_format, { type: "json_schema", json_schema: { name: "answer", schema, strict: true } });
});

test("Responses rejects invalid catalogs, schemas, choices and unsupported input without a worker", () => {
  for (const changes of [
    { tools: [{ type: "web_search" }] }, { tools: [{ type: "function", name: "bad.name" }] }, { tools: [...tools, ...tools] },
    { tools: [{ type: "function", name: "x", parameters: { type: "bogus" } }] },
    { tools: [{ type: "function", name: "x", parameters: { type: "object", unsupportedKeyword: true } }] },
    { tool_choice: { type: "function", name: "missing" } }, { tool_choice: "bad" }, { tools: [], tool_choice: "required" },
    { parallel_tool_calls: "false" }, { model: 1 }, { user: {} }, { metadata: [] }, { reasoning: { effort: 1 } }, { reasoning: { summary: "auto" } }, { response_format: { type: "xml" } }, { text: { format: false } }, { text: { format: { type: "json_schema", name: "x", schema: {}, strict: "true" } } }, { stream: 1 }, { instructions: 1 }, { previous_response_id: 2 }, { reasoning: "high" },
    { tools: [{ type: "function", name: "x", strict: "yes" }] }, { text: { format: { type: "xml" } } },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] },
    { input: [{ type: "function_call", call_id: "a", name: "x", arguments: "broken" }] },
    { input: [{ type: "function_call_output", call_id: "a", output: {} }] },
  ]) {
    const invalid = { ...body, ...changes } as ResponseRequest;
    assert.throws(() => responsesToChat(invalid, normalizeInput(invalid.input)));
  }
});

test("Responses enforces JSON schema, tool_choice and nonparallel batches at inference boundary", () => {
  const adapter = new CallerInference(normalizeResponsesTools(body), "unused", () => {}, () => {}, false, true);
  const call = { ...functionCall(), name: "caller_tool_0" };
  assert.equal(adapter.validateResponse(sse([call]))[0].name, "get_weather");
  for (const args of ["{}", '{"city":4}', '{"city":"Kyiv","extra":true}', "broken"]) assert.throws(() => adapter.validateResponse(sse([{ ...call, arguments: args }])), /arguments|JSON/);
  assert.throws(() => adapter.validateResponse(sse([{ ...call, name: "invented" }])), /allowlisted/);
  adapter.setChoice("required"); assert.throws(() => adapter.validateResponse(sse([])), /tool_choice/);
  adapter.setChoice("none"); assert.throws(() => adapter.validateResponse(sse([call])), /allowlisted/);
  adapter.setChoice({ type: "function", function: { name: "get_weather" } }); assert.equal(adapter.validateResponse(sse([call])).length, 1);
  adapter.setParallel(false); assert.throws(() => adapter.validateResponse(sse([call, { ...call, call_id: "call_2", id: "fc_2" }])), /parallel/);
  assert.equal(adapter.rewriteRequest({ input: [] }).parallel_tool_calls, false);
  adapter.setResponseFormat({ type: "json_schema", json_schema: { schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } } });
  assert.throws(() => adapter.validateFinalText('{}'), /schema/); assert.doesNotThrow(() => adapter.validateFinalText('{"answer":"ok"}'));
});

test("Codex completed summaries may omit output; completed SSE items retain their ordering", () => {
  const adapter = new CallerInference(normalizeResponsesTools(body), "unused", () => {}, () => {}, false, true);
  const item = { ...functionCall(), name: "caller_tool_0" };
  const raw = `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n` + sse([]);
  assert.equal(adapter.validateResponse(raw).length, 1);
  assert.equal(adapter.output.length, 1);
  assert.equal(adapter.output[0].call_id, item.call_id);
});

test("Responses hybrid inference retains native tools and only intercepts external aliases", () => {
  const adapter = new CallerInference(normalizeResponsesTools(body), "unused", () => {}, () => {}, true, true);
  const native = [{ type: "custom", name: "exec_command" }];
  assert.equal((adapter.rewriteRequest({ input: [], tools: native }).tools as unknown[]).length, 2);
  assert.deepEqual(adapter.validateResponse(sse([{ type: "custom_tool_call", name: "exec_command" }])), []);
  adapter.setChoice("none"); assert.deepEqual(adapter.rewriteRequest({ input: [], tools: native }).tools, native);
  assert.throws(() => adapter.validateResponse(sse([{ ...functionCall(), name: "caller_tool_0" }])), /allowlisted/);
});

test("bounded state restores text context, scopes owners and expires references", () => {
  let now = 1; const store = state(() => now);
  const first = store.prepare("owner", { input: "Hello", instructions: "Old instructions" }, normalizeInput("Hello"), "gpt-5.5", []);
  first.commit("resp_1", [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hi" }] }]);
  const next = store.prepare("owner", { input: "Again", previous_response_id: "resp_1" }, normalizeInput("Again"), "other", []);
  assert.equal(next.model, "gpt-5.5"); assert.equal(next.input.length, 3); assert.doesNotMatch(JSON.stringify(next.input), /Old instructions/);
  assert.throws(() => store.prepare("foreign", { ...body, previous_response_id: "resp_1" }, normalizeInput(body.input), "gpt-5.5", []), /foreign/);
  now = 102; assert.throws(() => store.prepare("owner", { ...body, previous_response_id: "resp_1" }, normalizeInput(body.input), "gpt-5.5", []), /expired/);
});

test("state supports two tool rounds, replay, model/catalog inheritance, locks and rejects duplicate or missing results", () => {
  const store = state(); const catalog = normalizeResponsesTools(body);
  store.prepare("owner", body, normalizeInput(body.input), "gpt-5.5", catalog).commit("resp_1", [functionCall(), functionCall("call_2")]);
  const nextBody = { input: [output(), output("call_2")], previous_response_id: "resp_1" };
  assert.throws(() => store.prepare("owner", { ...nextBody, input: [output()] }, [output()], "gpt-5.5", []), /every/);
  assert.throws(() => store.prepare("owner", { ...nextBody, input: [output(), output()] }, [output(), output()], "gpt-5.5", []), /duplicate/);
  assert.throws(() => store.prepare("owner", { ...nextBody, model: "different" }, nextBody.input, "different", []), /preserve/);
  assert.throws(() => store.prepare("owner", { ...nextBody, tools: [] }, nextBody.input, "gpt-5.5", []), /preserve/);
  assert.throws(() => store.prepare("owner", { ...nextBody, reasoning: { effort: "high" } }, nextBody.input, "gpt-5.5", []), /preserve execution/);
  const next = store.prepare("owner", nextBody, nextBody.input, "default", []);
  assert.equal(next.tools.length, 1); assert.equal(next.model, "gpt-5.5");
  assert.throws(() => store.prepare("owner", nextBody, nextBody.input, "default", []), /active/);
  next.commit("resp_2", [functionCall("call_3")]); next.release();
  assert.throws(() => store.prepare("owner", nextBody, nextBody.input, "default", []), /already submitted/);
  const replay = [...normalizeInput(body.input), functionCall(), functionCall("call_2"), output(), output("call_2"), functionCall("call_3"), output("call_3")];
  const last = store.prepare("owner", { ...body, input: replay }, replay, "gpt-5.5", catalog);
  assert.ok(last.pending); last.commit("resp_3", []);
  assert.throws(() => store.prepare("owner", { input: [output("unknown")] }, [output("unknown")], "gpt-5.5", []), /Unknown/);
});

test("store false, stateless completed replay and state resource limits are explicit", () => {
  const store = state(); const first = store.prepare("o", { ...body, store: false }, normalizeInput(body.input), "gpt-5.5", []); first.commit("resp_nostore", []);
  assert.throws(() => store.prepare("o", { ...body, previous_response_id: "resp_nostore" }, normalizeInput(body.input), "gpt-5.5", []), /Unknown/);
  assert.doesNotThrow(() => store.prepare("o", { ...body, input: [functionCall(), output()] }, [functionCall(), output()], "gpt-5.5", []));
  assert.throws(() => store.prepare("o", { input: "a".repeat(6000) }, normalizeInput("a".repeat(6000)), "m", []), /limit/);
  for (let i = 0; i < 3; i++) store.prepare("o", body, normalizeInput(body.input), "m", []).commit(`resp_${i}`, [functionCall(`call_${i}`)]);
  assert.throws(() => store.prepare("o", body, normalizeInput(body.input), "m", []).commit("resp_over", []), /capacity/);
});

test("buffered SSE reconstructs multiple calls with required fields and ordered completed items", () => {
  const events: any[] = []; let seq = 0;
  const emit = (type: string, data: object) => events.push({ type, ...data, sequence_number: seq++ });
  emitResponseItem(functionCall(), 0, emit); emitResponseItem(functionCall("call_2"), 1, emit);
  assert.deepEqual(events.map(event => event.type), Array(2).fill(["response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done"]).flat());
  for (const index of [0, 1]) {
    const batch = events.filter(event => event.output_index === index);
    assert.equal(batch[0].item.arguments, ""); assert.equal(batch[1].item_id, batch[0].item.id);
    assert.equal(batch[1].delta, batch[2].arguments); assert.equal(batch[2].name, "get_weather");
  }
});

test("official SDK HTTP integration covers mixed parallel items, previous_response_id, replay, streaming, failures and text", async t => {
  RESPONSE_STATE.clear();
  let round = 0; const received: ChatCompletionRequest[] = [];
  t.mock.method(CALLER_RUNTIME, "run", async (_req: unknown, _signal: unknown, options: { body: ChatCompletionRequest }) => {
    received.push(options.body);
    if (options.body.messages.some(message => message.content === "FAIL")) throw new CallerInferenceError("test_backend_failure", "Fixture failure");
    if (round++ === 0) return { ...result("Checking"), toolCalls: [functionCall(), functionCall("call_2")].map(call => ({ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } })), outputItems: [functionCall(), { type: "message", id: "msg_middle", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking", annotations: [] }] }, functionCall("call_2")] };
    if (round === 2) return { ...result(""), toolCalls: [{ id: "call_3", type: "function", function: { name: "get_weather", arguments: '{"city":"Lviv"}' } }] };
    return result("12 C");
  });
  const app = express(); app.use(express.json()); app.post("/v1/responses", (req, res) => void handleResponsesRequest(req, res, async (body, _signal, delta) => { assert.ok(body.input); delta?.("Hello"); return result("Hello"); }));
  const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = new OpenAI({ apiKey: "fixture", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, maxRetries: 0 });
  try {
    const first = await client.responses.create({ ...body, tool_execution_mode: "caller" } as any);
    assert.deepEqual(first.output.map(item => item.type), ["function_call", "message", "function_call"]);
    const second = await client.responses.create({ model: body.model, previous_response_id: first.id, input: [output(), output("call_2")], stream: true, ...{ tool_execution_mode: "caller" } });
    const events: any[] = []; for await (const event of second) events.push(event);
    const response = events.at(-1).response;
    assert.equal(events.at(-1).type, "response.completed"); assert.equal(response.output[0].type, "function_call");
    assert.deepEqual(events.map(event => event.sequence_number), events.map((_, i) => i));
    const final = await client.responses.create({ ...body, input: [...normalizeInput(body.input), ...first.output, output(), output("call_2"), ...response.output, output("call_3")], tool_execution_mode: "caller" } as any);
    assert.equal(final.output_text, "12 C"); assert.equal(received[1].tools?.length, 1);
    await assert.rejects(client.responses.create({ ...body, input: [output(), output("call_2")], previous_response_id: first.id } as any), /already submitted/);
    await assert.rejects(client.responses.create({ input: "Hi", previous_response_id: "expired" }), /expired/);
    const failed = await client.responses.create({ input: "FAIL", stream: true, ...{ tool_execution_mode: "caller" } });
    const failures: any[] = []; for await (const event of failed) failures.push(event);
    assert.equal(failures.at(-1).type, "response.failed"); assert.equal(failures.at(-1).response.error.code, "test_backend_failure");
    assert.equal(failures.filter(event => event.type === "response.completed").length, 0);
    const text = await client.responses.create({ input: "Hi", instructions: "Briefly" }); assert.equal(text.output_text, "Hello");
    const textStream = await client.responses.create({ input: [{ role: "user", content: "Hi" }, { role: "user", content: "Again" }], stream: true });
    let accumulated = ""; for await (const event of textStream) if (event.type === "response.output_text.delta") accumulated += event.delta;
    assert.equal(accumulated, "Hello");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); RESPONSE_STATE.clear(); }
});
