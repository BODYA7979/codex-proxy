import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import OpenAI from "openai";
import { normalizeResponsesRequest } from "../responses/options.js";
import { normalizeResponsesTools, normalizeInput, responsesToChat } from "../responses/validation.js";
import { handleResponsesRequest, RESPONSE_STATE } from "../responses/http.js";
import { CALLER_RUNTIME } from "../caller/runtime.js";
import { ResponseState } from "../responses/state.js";
import { responsesRequestToOptions } from "../adapter/openai-to-codex.js";
import type { ResponseRequest, ChatCompletionRequest } from "../types/openai.js";

const normalize = (extra: object) => normalizeResponsesRequest({ input: "Hi", ...extra } as ResponseRequest);
const tools = [{ type: "function" as const, name: "fixture", parameters: null, strict: null }];
const result = { text: "Done", turnId: "fixture", threadId: "fixture", finishReason: "stop" as const, usage: null, durationMs: null };

test("Responses normalizes every documented nullable SDK field before validation", () => {
  const fields = ["background", "context_management", "conversation", "include", "instructions", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "parallel_tool_calls", "previous_response_id", "prompt", "prompt_cache_key", "prompt_cache_retention", "reasoning", "safety_identifier", "service_tier", "store", "stream", "stream_options", "temperature", "top_logprobs", "top_p", "truncation", "user"];
  for (const key of fields) assert.deepEqual(normalize({ [key]: null }), { input: "Hi" }, key);
  const original = { reasoning: { effort: null, summary: null, generate_summary: null, context: null }, text: { verbosity: null } };
  assert.deepEqual(normalize(original), { input: "Hi" });
  assert.equal(original.text.verbosity, null); assert.equal(original.reasoning.summary, null);
  const schema = { type: "object", properties: { answer: { type: "string" } } };
  assert.doesNotThrow(() => responsesToChat({ input: "Hi", text: { format: { type: "json_schema", name: "answer", schema, strict: null } } }, normalizeInput("Hi")));
  const chat = responsesToChat({ input: "Hi", stream: null, store: null, parallel_tool_calls: null, instructions: null, user: null }, normalizeInput("Hi"));
  assert.equal(chat.parallel_tool_calls, undefined); assert.equal(chat.user, undefined);
  assert.deepEqual(normalizeResponsesTools({ input: "Hi", tools }), [{ type: "function", function: { name: "fixture" } }]);
});

test("Responses SDK defaults are accepted without silently enabling unsupported features", () => {
  for (const tier of ["auto", "default", "flex", "priority", "fast", "scale", "ultrafast"]) assert.equal(normalize({ service_tier: tier }).service_tier, tier);
  for (const verbosity of ["low", "medium", "high"]) assert.equal(normalize({ text: { verbosity } }).text?.verbosity, verbosity);
  for (const retention of ["in_memory", "24h"]) assert.equal(normalize({ prompt_cache_retention: retention }).prompt_cache_retention, retention);
  assert.doesNotThrow(() => normalize({ prompt_cache_options: { mode: "implicit", ttl: "30m", prewarm: false, comparison_response_id: null } }));
  assert.doesNotThrow(() => normalize({ stream: true, stream_options: { include_obfuscation: false } }));
  assert.deepEqual(normalize({ top_logprobs: 0, context_management: [] }), { input: "Hi" });
  for (const extra of [
    { unknown_option: null }, { model: null }, { input: null }, { tools: null }, { background: true }, { conversation: "conv_fixture" },
    { include: ["reasoning.encrypted_content"] }, { truncation: "auto" }, { prompt: { id: "pmpt_fixture" } }, { top_logprobs: 1 },
    { stream_options: {} }, { stream: true, stream_options: { include_obfuscation: null } }, { stream: true, stream_options: { unknown: false } },
    { service_tier: "invented" }, { text: { verbosity: "invented" } }, { prompt_cache_retention: "invented" },
    { prompt_cache_options: { mode: "explicit" } }, { prompt_cache_options: { prewarm: true } }, { prompt_cache_options: { comparison_response_id: "resp_fixture" } }, { prompt_cache_options: { unknown: null } },
  ]) {
    const request = { input: "Hi", ...extra } as unknown as ResponseRequest;
    assert.throws(() => responsesToChat(request, normalizeInput(request.input)), Error, JSON.stringify(extra));
  }
});

test("native Codex options preserve SDK verbosity, service tier and existing overrides", () => {
  const defaults = { configOverrides: { existing: "true" }, serviceTier: "priority" };
  const converted = responsesRequestToOptions({ input: "Hi", text: { verbosity: "low" }, service_tier: "default" }, defaults);
  assert.equal(converted.options.serviceTier, "default");
  assert.deepEqual(converted.options.configOverrides, { existing: "true", model_verbosity: '"low"' });
  assert.deepEqual(defaults.configOverrides, { existing: "true" });
  assert.equal(responsesRequestToOptions({ input: "Hi", service_tier: "auto" }, defaults).options.serviceTier, "priority");
});

test("pending Responses inherit SDK settings after null normalization and reject actual changes", () => {
  const state = new ResponseState(() => ({ ttl: 1000, entries: 4, bytes: 10000, historyBytes: 5000 }));
  const first = normalize({ service_tier: "priority", text: { verbosity: "low" } });
  state.prepare("owner", first, normalizeInput(first.input), "m", []).commit("resp_first", [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "fixture", arguments: "{}", status: "completed" }]);
  const next = normalize({ input: [{ type: "function_call_output", call_id: "call_fixture", output: "ok" }], previous_response_id: "resp_first", service_tier: null, text: { verbosity: null }, reasoning: null });
  const prepared = state.prepare("owner", next, normalizeInput(next.input), "m", []);
  assert.equal(prepared.execution.service_tier, "priority"); assert.equal(prepared.execution.text?.verbosity, "low"); prepared.release();
  assert.throws(() => state.prepare("owner", { ...next, service_tier: "default" }, normalizeInput(next.input), "m", []), /preserve execution/);
  assert.throws(() => state.prepare("owner", { ...next, text: { verbosity: "high" } }, normalizeInput(next.input), "m", []), /preserve execution/);
});

test("official Responses SDK accepts nulls and common options in all execution paths", async t => {
  const received: Array<{ body: ChatCompletionRequest; responseOptions?: Pick<ResponseRequest, "service_tier" | "text"> }> = [];
  t.mock.method(CALLER_RUNTIME, "run", async (_req: unknown, _signal: unknown, options: typeof received[number]) => { received.push(options); return result; });
  let nativeRuns = 0;
  const app = express(); app.use(express.json());
  app.post(["/responses", "/v1/responses"], (req, res) => void handleResponsesRequest(req, res, async (body, _signal, delta) => {
    nativeRuns++; const { options } = responsesRequestToOptions(body);
    assert.equal(options.serviceTier, "priority"); assert.equal(options.configOverrides?.model_verbosity, '"low"');
    delta?.("Done"); return result;
  }));
  const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = new OpenAI({ apiKey: "fixture", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, maxRetries: 0 });
  try {
    // The documented wire schema also permits user:null; the pinned SDK's
    // deprecated user type is narrower, so exercise its serializer explicitly.
    const common = { model: "gpt-5.5", input: "Hi", instructions: null, parallel_tool_calls: null, store: null, user: null, previous_response_id: null, temperature: null, top_p: null, max_output_tokens: null, service_tier: "priority", text: { verbosity: "low" }, prompt_cache_key: "fixture_PRIMARY", safety_identifier: "", prompt_cache_retention: "24h", prompt_cache_options: { mode: "implicit", ttl: "30m", prewarm: false }, reasoning: { effort: null, summary: null }, prompt: null, context_management: null, moderation: null, stream_options: null } as unknown as Omit<OpenAI.Responses.ResponseCreateParams, "stream">;
    for (const execution of [{ tool_execution_mode: "hybrid" }, { tool_execution_mode: "caller", tools }, { tool_execution_mode: "hybrid", tools }]) {
      const json = await client.responses.create({ ...common, ...execution, stream: null });
      assert.equal(json.output_text, "Done"); assert.equal((json as unknown as { store: boolean }).store, true); assert.equal(json.parallel_tool_calls, true); assert.equal(json.text?.verbosity, "low");
      // null store means omission (default true), so the response must be chainable.
      const chained = await client.responses.create({ ...common, ...execution, previous_response_id: json.id, input: "Again", stream: false });
      assert.equal(chained.output_text, "Done");
      for (const obfuscation of [false, true]) {
        const stream = await client.responses.create({ ...common, ...execution, stream: true, stream_options: { include_obfuscation: obfuscation } });
        const events: any[] = []; for await (const event of stream) events.push(event);
        assert.equal(events.at(-1).type, "response.completed"); assert.equal(events.at(-1).response.output_text, "Done");
        const deltas = events.filter(event => event.type.endsWith(".delta")); assert.ok(deltas.length);
        for (const delta of deltas) {
          assert.equal(typeof delta.obfuscation, obfuscation ? "string" : "undefined");
          if (obfuscation) assert.equal(Buffer.byteLength(JSON.stringify(delta)) % 256, 0);
        }
      }
    }
    assert.equal(nativeRuns, 4); assert.equal(received.length, 8);
    for (const request of received) {
      assert.equal(request.responseOptions?.service_tier, "priority"); assert.equal(request.responseOptions?.text?.verbosity, "low");
      assert.equal(request.body.parallel_tool_calls, undefined); assert.equal(request.body.user, undefined);
      assert.deepEqual(request.body.tools?.[0]?.function.parameters, undefined);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); RESPONSE_STATE.clear(); }
});
