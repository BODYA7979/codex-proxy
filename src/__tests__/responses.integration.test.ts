/** Official SDK -> real Express routes -> real installed Codex app-server ->
 * deterministic inference server. No external client operation is run by proxy. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import OpenAI from "openai";
import { CONFIG } from "../server/config.js";
import { createApp } from "../server/index.js";
import { CALLER_RUNTIME } from "../caller/runtime.js";
import { RESPONSE_STATE } from "../responses/http.js";

const enabled = process.env.CODEX_PROXY_RESPONSES_INTEGRATION === "1";
const tools: OpenAI.Responses.FunctionTool[] = ["weather", "news"].map(name => ({ type: "function", name, description: `Client ${name}`, strict: true, parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } }));
const message = (text: string) => ({ type: "message", id: `msg_${Math.random()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const call = (index: number, id: string, args = '{"city":"Kyiv"}') => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: `caller_tool_${index}`, arguments: args, status: "completed" });
function stream(items: Record<string, unknown>[]) {
  const response = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "gpt-5.5", output: items, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  let result = `data: ${JSON.stringify({ type: "response.created", response: { ...response, output: [], status: "in_progress" } })}\n\n`;
  items.forEach((item, output_index) => {
    result += `data: ${JSON.stringify({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : {}) } })}\n\n`;
    if (item.type === "message") result += `data: ${JSON.stringify({ type: "response.output_text.delta", output_index, item_id: item.id, content_index: 0, delta: (item.content as any[])[0].text })}\n\n`;
    result += `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`;
  });
  return result + `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
}
async function listen(server: Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
const outputs = (response: OpenAI.Responses.Response) => response.output.filter(item => item.type === "function_call").map(item => ({ type: "function_call_output" as const, call_id: item.call_id, output: `CLIENT:${item.name}:12 C` }));

async function consume(stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>) {
  const events: any[] = []; for await (const event of stream) events.push(event);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, i) => i));
  assert.equal(events[0].type, "response.created"); assert.equal(events[1].type, "response.in_progress");
  for (const event of events.filter(event => event.type === "response.function_call_arguments.done")) {
    assert.equal(events.filter(e => e.type === "response.function_call_arguments.delta" && e.item_id === event.item_id).map(e => e.delta).join(""), event.arguments);
    assert.equal(typeof event.name, "string");
  }
  assert.equal(events.at(-1).type, "response.completed", JSON.stringify(events.at(-1)));
  const response = events.at(-1).response as OpenAI.Responses.Response;
  assert.equal(events.filter(event => event.type === "response.output_item.done").length, response.output.length);
  return response;
}

test("Responses SDK full cycles through installed app-server", { skip: !enabled, timeout: 180_000 }, async t => {
  const saved = { ...CONFIG }; let pendingWait: (() => void) | undefined;
  const received: any[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); received.push(body);
      const text = JSON.stringify(body.input);
      const results = body.input.filter((item: any) => item.type === "function_call_output");
      let items: Record<string, unknown>[];
      if (text.includes("CASE:CANCEL") || text.includes("CASE:TIMEOUT")) { pendingWait?.(); return; }
      else if (text.includes("CASE:INVALID")) items = [call(0, "invalid", '{}')];
      else if (text.includes("CASE:UNKNOWN")) items = [{ ...call(0, "unknown"), name: "hallucinated" }];
      else if (text.includes("CASE:NONPARALLEL")) items = [call(0, "one"), call(1, "two")];
      else if (text.includes("CASE:ERROR")) items = [{ type: "forbidden_tool", id: "x" }];
      else if (text.includes("CASE:REPLAY") && text.includes("CLIENT:") && !results.length) items = [message("Replay complete")];
      else if (text.includes("CASE:TEXT") || body.tool_choice === "none") items = [message('{"answer":"Hello"}')];
      else if (!results.length) {
        if (text.includes("CASE:NAMED")) { assert.equal(body.tool_choice.name, "caller_tool_1"); items = [call(1, "named")]; }
        else if (text.includes("CASE:REQUIRED")) { assert.equal(body.tool_choice, "required"); items = [call(1, "required")]; }
        else if (text.includes("CASE:ORDER")) items = [call(0, "first"), message("Between calls"), call(1, "second")];
        else if (text.includes("CASE:PARALLEL")) items = [message("Checking. "), call(0, "first"), call(1, "second")];
        else items = [call(0, "first")];
      } else if (text.includes("CASE:PARALLEL") && results.length === 2) items = [call(1, "third")];
      else if (text.includes("CASE:INSTRUCTIONS")) { assert.match(text, /New instruction/); assert.doesNotMatch(text, /Old instruction/); items = [message("New instruction honored")]; }
      else items = [message(`Final: ${results.map((item: any) => JSON.stringify(item.output)).join(" | ")}`)];
      res.writeHead(200, { "content-type": "text/event-stream" }).end(stream(items));
    } catch (error) { res.writeHead(400).end(String(error)); }
  });
  const api = createServer(createApp());
  try {
    CONFIG.toolExecutionMode = "caller"; CONFIG.defaultTimeoutMs = 10000; CONFIG.initTimeoutMs = 10000;
    CONFIG.callerUpstream = `http://127.0.0.1:${await listen(upstream)}`;
    const baseURL = `http://127.0.0.1:${await listen(api)}/v1`;
    const client = new OpenAI({ apiKey: "fixture", baseURL, maxRetries: 0 });
    for (const streaming of [false, true]) await t.test(`single and parallel multi-round cycle (${streaming ? "SSE" : "JSON"})`, async () => {
      for (const parallel of [false, true]) {
        const request = { model: "gpt-5.5", input: `CASE:${parallel ? "PARALLEL" : "SINGLE"}`, tools };
        const first = streaming ? await consume(await client.responses.create({ ...request, stream: true })) : await client.responses.create(request);
        assert.equal(outputs(first).length, parallel ? 2 : 1);
        assert.deepEqual(outputs(first).map(item => item.output), parallel ? ["CLIENT:weather:12 C", "CLIENT:news:12 C"] : ["CLIENT:weather:12 C"]);
        if (parallel) { assert.equal(first.output[0].type, "message"); assert.equal(first.output_text, "Checking. "); }
        const foreign = new OpenAI({ apiKey: "foreign", baseURL, maxRetries: 0 });
        await assert.rejects(foreign.responses.create({ model: "gpt-5.5", previous_response_id: first.id, input: outputs(first) }), /foreign/);
        await assert.rejects(client.responses.create({ model: "gpt-5.5", previous_response_id: first.id, input: [{ ...outputs(first)[0], call_id: "unknown" }] }), /Unknown/);
        const nextRequest = { model: "gpt-5.5", previous_response_id: first.id, input: outputs(first) };
        let last = streaming ? await consume(await client.responses.create({ ...nextRequest, stream: true })) : await client.responses.create(nextRequest);
        await assert.rejects(client.responses.create(nextRequest), /already submitted/);
        if (parallel) { assert.equal(outputs(last).length, 1); last = await client.responses.create({ model: "gpt-5.5", previous_response_id: last.id, input: outputs(last) }); }
        assert.match(last.output_text, /CLIENT:/); assert.equal(outputs(last).length, 0);
      }
    });
    await t.test("explicit history replay, store false and a fresh worker from completed history", async () => {
      const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content: "CASE:REPLAY" }];
      const first = await client.responses.create({ model: "gpt-5.5", tools, input, store: false });
      await assert.rejects(client.responses.create({ model: "gpt-5.5", previous_response_id: first.id, input: outputs(first) }), /Unknown/);
      input.push(...first.output as OpenAI.Responses.ResponseInputItem[], ...outputs(first));
      const final = await client.responses.create({ model: "gpt-5.5", tools, input, store: false }); assert.match(final.output_text, /CLIENT:/);
      input.push(...final.output as OpenAI.Responses.ResponseInputItem[], { role: "user", content: "Continue" });
      const replay = await client.responses.create({ model: "gpt-5.5", tools, input, store: false }); assert.equal(replay.output_text, "Replay complete");
    });
    await t.test("choices, instructions, JSON modes and ordinary text", async () => {
      for (const choice of ["none", "required", { type: "function", name: "news" }] as const) {
        const input = typeof choice === "object" ? "CASE:NAMED" : choice === "required" ? "CASE:REQUIRED" : "CASE:TEXT";
        const response = await client.responses.create({ model: "gpt-5.5", tools, input, tool_choice: choice });
        if (outputs(response).length) { assert.equal((response.output[0] as OpenAI.Responses.ResponseFunctionToolCall).name, "news"); await client.responses.create({ model: "gpt-5.5", previous_response_id: response.id, input: outputs(response) }); }
        else assert.match(response.output_text, /Hello/);
      }
      const first = await client.responses.create({ model: "gpt-5.5", tools, input: "CASE:INSTRUCTIONS", instructions: "Old instruction" });
      const second = await client.responses.create({ model: "gpt-5.5", input: outputs(first), previous_response_id: first.id, instructions: "New instruction" });
      assert.equal(second.output_text, "New instruction honored");
      const json = await client.responses.create({ model: "gpt-5.5", input: "CASE:TEXT", text: { format: { type: "json_object" } } }); assert.deepEqual(JSON.parse(json.output_text), { answer: "Hello" });
      const text = await consume(await client.responses.create({ model: "gpt-5.5", instructions: "Concise", input: [{ role: "user", content: "CASE:TEXT" }, { role: "user", content: "Hi" }], stream: true })); assert.match(text.output_text, /Hello/);
    });
    await t.test("interleaved messages and calls preserve order without repeated text", async () => {
      const response = await client.responses.create({ model: "gpt-5.5", tools, input: "CASE:ORDER" });
      assert.deepEqual(response.output.map(item => item.type), ["function_call", "message", "function_call"]);
      assert.equal(response.output_text, "Between calls");
      const final = await client.responses.create({ model: "gpt-5.5", previous_response_id: response.id, input: outputs(response) });
      assert.doesNotMatch(final.output_text, /Between calls/);
      assert.match(final.output_text, /CLIENT:/);
    });
    await t.test("hybrid retains native definitions alongside external functions", async () => {
      const response = await client.responses.create({ model: "gpt-5.5", tools, input: "CASE:HYBRID", ...{ tool_execution_mode: "hybrid" } });
      const request = received.at(-1);
      const names = request.tools.map((tool: any) => tool.name || tool.type);
      assert.ok(names.some((name: string) => !/^caller_tool_/.test(name)), JSON.stringify(names));
      assert.equal(names.filter((name: string) => name === "caller_tool_0").length, 1);
      assert.equal(outputs(response).length, 1);
      const final = await client.responses.create({ model: "gpt-5.5", previous_response_id: response.id, input: outputs(response), ...{ tool_execution_mode: "hybrid" } }); assert.match(final.output_text, /CLIENT:/);
    });
    await t.test("invalid arguments, names, parallel policy and streaming failure", async () => {
      for (const input of ["CASE:INVALID", "CASE:UNKNOWN"]) await assert.rejects(client.responses.create({ model: "gpt-5.5", tools, input }), /arguments|allowlisted/);
      await assert.rejects(client.responses.create({ model: "gpt-5.5", tools, input: "CASE:NONPARALLEL", parallel_tool_calls: false }), /parallel/);
      const events: any[] = []; for await (const event of await client.responses.create({ model: "gpt-5.5", tools, input: "CASE:ERROR", stream: true })) events.push(event);
      assert.equal(events.at(-1).type, "response.failed"); assert.equal(events.at(-1).response.error.code, "caller_forbidden_tool_item");
      assert.equal(events.some(event => event.type === "response.completed"), false);
    });
    await t.test("disconnect aborts active inference and pending output cannot be replayed twice", async () => {
      const started = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Cancellation fixture did not start")), 10000); timer.unref(); pendingWait = () => { clearTimeout(timer); resolve(); }; });
      const stream = await client.responses.create({ model: "gpt-5.5", tools, input: "CASE:CANCEL", stream: true });
      await started; stream.controller.abort();
      await new Promise(resolve => setTimeout(resolve, 100));
      const followup = await client.responses.create({ model: "gpt-5.5", input: "CASE:TEXT" }); assert.match(followup.output_text, /Hello/);
    });
    await t.test("active inference timeout returns a failed Responses stream", async () => {
      CONFIG.defaultTimeoutMs = 200;
      try {
        const events: any[] = [];
        for await (const event of await client.responses.create({ model: "gpt-5.5", tools, input: "CASE:TIMEOUT", stream: true })) events.push(event);
        assert.equal(events.at(-1).type, "response.failed");
        assert.equal(events.at(-1).response.error.code, "codex_timeout");
        assert.equal(events.some(event => event.type === "response.completed"), false);
      } finally { CONFIG.defaultTimeoutMs = 10000; }
    });
    assert.ok(received.length > 10);
  } finally { await CALLER_RUNTIME.drain(); RESPONSE_STATE.clear(); Object.assign(CONFIG, saved); await close(api); await close(upstream); }
});
