/** Exact n8n provider version -> HTTP -> optional real Bifrost -> installed
 * app-server -> deterministic local inference. All data is synthetic. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { CONFIG } from "../server/config.js";
import { createApp } from "../server/index.js";
import { CALLER_RUNTIME } from "../caller/runtime.js";
import { RESPONSE_STATE } from "../responses/http.js";

const exec = promisify(execFile);
async function listen(server: Server): Promise<number> { server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function sse(output: any[]): string {
  let text = "";
  output.forEach((item, output_index) => {
    text += `data: ${JSON.stringify({ type: "response.output_item.added", output_index, item: { ...item, ...(item.type === "function_call" ? { arguments: "" } : {}) } })}\n\n`;
    if (item.type === "message") text += `data: ${JSON.stringify({ type: "response.output_text.delta", output_index, item_id: item.id, content_index: 0, delta: item.content[0].text })}\n\n`;
    text += `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`;
  });
  return text + `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`;
}
const tools = [{ type: "function" as const, name: "read", description: "Synthetic external read", inputSchema: { type: "object", properties: { path: { type: "string" }, note: { type: "string" } }, required: ["path", "note"], additionalProperties: false } }];
const call = (id: string, note: string) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "caller_tool_0", arguments: `{ "note": "${note}", "path": "fixture.txt" }`, status: "completed" });
const message = (text: string) => ({ type: "message", id: `msg_${Math.random()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const enabled = process.env.CODEX_PROXY_RESPONSES_INTEGRATION === "1";

test("n8n AI SDK 4.0.20 stored item replay and content-array results", { skip: !enabled, timeout: 180_000 }, async t => {
  const saved = { ...CONFIG }, received: any[] = [];
  const directory = await mkdtemp(join(tmpdir(), "codex-ai-sdk-replay-")); let container: string | undefined;
  const upstream = createServer(async (req, res) => {
    try {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); const outputs = body.input.filter((item: any) => item.type === "function_call_output");
      const replay = JSON.stringify(body.input);
      if (replay.includes("Continue from the same history")) {
        for (const context of ["Checking client data", "Checking one more item", "CLIENT_PART_ONE", "CLIENT_PART_TWO", "Final result:"]) assert.ok(replay.includes(context), `Missing restored context: ${context}`);
        assert.ok(!body.input.some((item: any) => item.type === "item_reference"));
        res.writeHead(200, { "content-type": "text/event-stream" }).end(sse([message("Retained context verified after idle expiry")])); return;
      }
      const items = !outputs.length ? [message("Checking client data"), call("first", "one"), call("second", "two")]
        : outputs.length === 2 ? [message("Checking one more item"), call("third", "three")]
          : [message("Final result: CLIENT_PART_ONE / CLIENT_PART_TWO")];
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(items));
    } catch { res.writeHead(400).end(); }
  });
  const api = createServer(createApp());
  try {
    CONFIG.toolExecutionMode = "caller"; CONFIG.defaultTimeoutMs = 15000; CONFIG.initTimeoutMs = 15000;
    CONFIG.callerUpstream = `http://127.0.0.1:${await listen(upstream)}`;
    const apiPort = await listen(api);
    const targets = [{ name: "direct", url: `http://127.0.0.1:${apiPort}`, model: "gpt-5.5" }];
    const image = process.env.CODEX_PROXY_TEST_BIFROST_IMAGE;
    if (image) {
      const data = join(directory, "bifrost"); await mkdir(data);
      await writeFile(join(data, "config.json"), JSON.stringify({ client: { enable_logging: false }, providers: { openai: { keys: [{ name: "fixture", value: "fixture-only", models: ["*"], weight: 1 }], network_config: { base_url: `http://host.docker.internal:${apiPort}`, max_retries: 0 } } }, config_store: { enabled: false }, logs_store: { enabled: false } }));
      const started = await exec("docker", ["run", "--rm", "-d", "--name", `codex-ai-sdk-${process.pid}`, "-p", "127.0.0.1::8080", "-v", `${data}:/app/data`, image]); container = started.stdout.trim();
      const { stdout } = await exec("docker", ["port", container, "8080/tcp"]); const gateway = `http://127.0.0.1:${stdout.trim().split(":").at(-1)}`;
      let ready = false;
      for (let i = 0; i < 80; i++) { try { if ((await fetch(`${gateway}/health`)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 200)); }
      assert.ok(ready, "Bifrost failed startup"); targets.push({ name: "Bifrost", url: gateway, model: "openai/gpt-5.5" });
    }
    for (const target of targets) for (const streaming of [false, true]) await t.test(`${target.name}: references, parallel batch, text arrays and second round (${streaming ? "SSE" : "JSON"})`, async () => {
      const requests: any[] = [];
      const provider = createOpenAI({ baseURL: `${target.url}/v1`, apiKey: "fixture", fetch: async (url, init) => { requests.push(JSON.parse(String(init?.body))); return fetch(url, init); } });
      const model = provider.responses(target.model); const prompt: any[] = [{ role: "user", content: [{ type: "text", text: "SDK_REPLAY read fixture data" }] }];
      const run = async () => {
        if (!streaming) return model.doGenerate({ prompt, tools });
        const response = await model.doStream({ prompt, tools }); const content: any[] = []; let text = "";
        for await (const part of response.stream as any) {
          if (part.type === "text-delta") text += part.delta;
          if (part.type === "text-end") { content.push({ type: "text", text, providerMetadata: part.providerMetadata }); text = ""; }
          if (part.type === "tool-call") content.push(part);
          if (part.type === "error") throw part.error;
        }
        return { content };
      };
      const addResults = (response: { content: any[] }) => {
        prompt.push({ role: "assistant", content: response.content.map(part => part.type === "tool-call"
          ? { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.parse(part.input) }
          : { type: "text", text: part.text, providerOptions: part.providerMetadata }) });
        prompt.push({ role: "tool", content: response.content.filter(part => part.type === "tool-call").map(part => ({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: { type: "content", value: [{ type: "text", text: "CLIENT_PART_ONE" }, { type: "text", text: "CLIENT_PART_TWO" }] } })) });
      };
      const first = await run(); assert.equal(first.content.filter(part => part.type === "tool-call").length, 2); addResults(first);
      const next = await run(); assert.equal(next.content.filter(part => part.type === "tool-call").length, 1);
      assert.ok(requests[1].input.some((item: any) => item.type === "item_reference"));
      assert.ok(requests[1].input.some((item: any) => item.type === "function_call_output" && Array.isArray(item.output)));
      addResults(next);
      // Shorten only this completed response's history TTL to reproduce an idle
      // chat without a ten-minute test. Item retention remains independently set.
      const savedTtl = CONFIG.callerTtlMs;
      let last: { content: any[] };
      try { CONFIG.callerTtlMs = 20; last = await run(); }
      finally { CONFIG.callerTtlMs = savedTtl; }
      assert.match(last.content.filter(part => part.type === "text").map(part => part.text).join(""), /CLIENT_PART_ONE.*CLIENT_PART_TWO/);
      await new Promise(resolve => setTimeout(resolve, 30));
      RESPONSE_STATE.sweep(); await CALLER_RUNTIME.drain();
      // Continue after the original turn has completed, replaying the entire
      // SDK-built history with references to both earlier response segments.
      prompt.push({ role: "assistant", content: last.content.filter(part => part.type === "text").map(part => ({ type: "text", text: part.text, providerOptions: part.providerMetadata })) });
      prompt.push({ role: "user", content: [{ type: "text", text: "Continue from the same history" }] });
      const continued = await run(); // new thread replays after history/worker expiry
      assert.match(continued.content.filter(part => part.type === "text").map(part => part.text).join(""), /Retained context verified after idle expiry/);
      const refs = requests.at(-1).input.filter((item: any) => item.type === "item_reference"); assert.ok(refs.length >= 3);
      received.push({ target: target.name, streaming, references: refs.length });
    });
    assert.ok(received.length >= 2);
  } finally { await CALLER_RUNTIME.drain(); RESPONSE_STATE.clear(); Object.assign(CONFIG, saved); if (container) await exec("docker", ["rm", "-f", container]).catch(() => {}); await close(api); await close(upstream); await rm(directory, { recursive: true, force: true }); }
});
