/** Opt-in: real installed app-server, deterministic local inference; no paid model
 * calls. Set CODEX_PROXY_TEST_BIFROST_IMAGE and CODEX_PROXY_TEST_OPENCODE=1 to
 * exercise the actual gateway and external CLI as well. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../server/config.js";
import { createApp } from "../server/index.js";
import { CALLER_RUNTIME } from "../caller/runtime.js";
import type { ChatCompletionRequest, ChatMessage, ChatCompletionToolCall } from "../types/openai.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const tools: NonNullable<ChatCompletionRequest["tools"]> = [
  { type: "function", function: { name: "bash", description: "Execute on the external client", parameters: { type: "object", properties: { command: { type: "string" }, description: { type: "string" } }, required: ["command", "description"] } } },
  { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];
function message(text: string): Record<string, unknown> { return { type: "message", id: `msg_${Math.random()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }; }
function call(index: number, id: string, args: Record<string, unknown>): Record<string, unknown> { return { type: "function_call", id: `fc_${id}`, call_id: id, name: `caller_tool_${index}`, arguments: JSON.stringify(args), status: "completed" }; }
function sse(output: Record<string, unknown>[]): string {
  const response = { id: `resp_${Math.random()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: "gpt-5.5", output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  let stream = `data: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`;
  output.forEach((item, output_index) => {
    stream += `data: ${JSON.stringify({ type: "response.output_item.added", output_index, item: { ...item, arguments: item.arguments === undefined ? undefined : "" } })}\n\n`;
    stream += `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`;
  });
  return stream + `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
}
async function listen(server: Server): Promise<number> { server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

// A route parser that emulates how OpenCode reconstructs assistant messages from
// SSE. It checks IDs, indexes, arguments and finish_reason as well as mixed text.
async function completion(url: string, messages: ChatMessage[], user: string, streaming: boolean, extra: object = {}) {
  const response = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: url.includes("gateway") ? "openai/gpt-5.5" : "gpt-5.5", tools, messages, user, stream: streaming, ...extra }) });
  const raw = await response.text();
  if (!streaming || response.status !== 200) return { status: response.status, body: JSON.parse(raw) };
  const events = raw.split("\n\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6));
  assert.equal(events.at(-1), "[DONE]");
  let text = "";
  const calls: ChatCompletionToolCall[] = [];
  let finish: string | undefined;
  const ids = new Set<string>();
  for (const data of events.slice(0, -1)) {
    const event = JSON.parse(data);
    if (event.error) return { status: 502, body: event };
    ids.add(event.id);
    const choice = event.choices[0];
    text += choice.delta.content || "";
    for (const call of choice.delta.tool_calls || []) { assert.equal(call.index, calls.length); calls.push(call); }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  assert.equal(ids.size, 1);
  return { status: 200, body: { choices: [{ message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }] } };
}

const enabled = process.env.CODEX_PROXY_CALLER_INTEGRATION === "1";
test("caller execution through real app-server and optional Bifrost/OpenCode", { skip: !enabled, timeout: 180_000 }, async t => {
  const saved = { ...CONFIG };
  const requests: Array<Record<string, any>> = [];
  const directory = await mkdtemp(join(tmpdir(), "codex-caller-integration-"));
  const forbiddenMarker = join(directory, "native-shell-must-not-run");
  let container: string | undefined;
  const upstream = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      assert.ok(body.tools.every((tool: any) => /^caller_tool_\d+$/.test(tool.name)));
      const text = JSON.stringify(body.input);
      const outputs = body.input.filter((item: any) => item.type === "function_call_output");
      let output: Record<string, unknown>[];
      if (text.includes("SCENARIO:blocked")) output = [{ ...call(0, "native", { command: `touch ${forbiddenMarker}` }), name: "exec_command" }];
      else if (text.includes("SCENARIO:cancel-active")) { await sleep(700); output = [message("Cancelled inference")]; }
      else if (body.tool_choice === "none") output = [message('{"ok":true}')];
      else if (!outputs.length) {
        if (text.includes("SCENARIO:parallel")) output = [message("Checking client directory. "), call(0, "batch_a", { command: "ls", description: "List files" }), call(1, "batch_b", { path: "README.md" })];
        else {
          const index = body.tool_choice?.type === "function" ? Number(body.tool_choice.name.split("_").at(-1)) : body.tool_choice === "required" ? 1 : body.tools.findIndex((tool: any) => tool.description?.includes("bash"));
          // OpenCode's bash description contains 'bash'; deterministic tests use index 0.
          const selected = index < 0 ? 0 : index;
          const args = body.tools[selected].parameters?.properties?.command ? { command: "pwd && ls", description: "Show client files" } : { path: "README.md" };
          output = [call(selected, "first", args)];
        }
      } else if (text.includes("SCENARIO:parallel") && outputs.length === 2) output = [message("Retrying after client error. "), call(0, "second", { command: "cat client.txt", description: "Read client file" })];
      else output = [message(`Client results: ${outputs.map((item: any) => typeof item.output === "string" ? item.output : JSON.stringify(item.output)).join(" | ")}`)];
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(output));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  const api = createServer(createApp());
  try {
    CONFIG.toolExecutionMode = "caller"; CONFIG.defaultTimeoutMs = 15_000; CONFIG.initTimeoutMs = 15_000;
    CONFIG.callerUpstream = `http://127.0.0.1:${await listen(upstream)}`;
    const apiPort = await listen(api);
    const direct = `http://127.0.0.1:${apiPort}`;
    const targets = [{ name: "direct", url: direct, extra: {} }];
    const image = process.env.CODEX_PROXY_TEST_BIFROST_IMAGE;
    if (image) {
      const data = join(directory, "bifrost");
      const { mkdir } = await import("node:fs/promises"); await mkdir(data);
      await writeFile(join(data, "config.json"), JSON.stringify({ client: { enable_logging: false }, providers: { openai: { keys: [{ name: "local-test", value: "fixture-only", models: ["*"], weight: 1 }], network_config: { base_url: `http://host.docker.internal:${apiPort}`, max_retries: 0 } } }, config_store: { enabled: false }, logs_store: { enabled: false } }));
      container = `codex-caller-test-${process.pid}`;
      await exec("docker", ["run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::8080", "-v", `${data}:/app/data`, image]);
      const { stdout } = await exec("docker", ["port", container, "8080/tcp"]);
      const port = stdout.trim().split(":").at(-1);
      const gateway = `http://127.0.0.1:${port}`;
      let available = false;
      for (let i = 0; i < 60; i++) { try { const r = await fetch(`${gateway}/health`); if (r.ok) { available = true; break; } } catch {} await sleep(200); }
      if (!available) { const logs = await exec("docker", ["logs", container]); throw new Error(`Bifrost did not start: ${logs.stdout} ${logs.stderr}`); }
      targets.push({ name: "Bifrost", url: gateway, extra: { model: "openai/gpt-5.5" } });
    }

    for (const target of targets) for (const streaming of [false, true]) {
      await t.test(`${target.name}: mixed text, parallel calls, error, sequential call, results (${streaming ? "SSE" : "JSON"})`, async () => {
        const messages: ChatMessage[] = [{ role: "user", content: "SCENARIO:parallel Show files in the client directory" }];
        const a = await completion(target.url, messages, "tenant-a", streaming, target.extra);
        assert.equal(a.status, 200, JSON.stringify(a.body));
        const assistant = a.body.choices[0].message;
        assert.match(assistant.content, /Checking client/); assert.equal(assistant.tool_calls.length, 2);
        assert.deepEqual(assistant.tool_calls.map((c: any) => c.function.name), ["bash", "read"]);
        assert.equal(a.body.choices[0].finish_reason, "tool_calls");
        assert.notEqual(assistant.tool_calls[0].id, assistant.tool_calls[1].id);
        messages.push(assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "client.txt\nREADME.md" }, { role: "tool", tool_call_id: assistant.tool_calls[1].id, content: "ERROR: file not found" });
        const foreign = await completion(target.url, messages, "tenant-b", false, target.extra);
        assert.equal(foreign.status, 400, JSON.stringify(foreign.body));
        const b = await completion(target.url, messages, "tenant-a", streaming, target.extra);
        assert.equal(b.status, 200, JSON.stringify(b.body)); assert.match(b.body.choices[0].message.content, /Retrying/);
        const next = b.body.choices[0].message; assert.equal(next.tool_calls.length, 1);
        messages.push(next, { role: "tool", tool_call_id: next.tool_calls[0].id, content: "client contents" });
        const c = await completion(target.url, messages, "tenant-a", streaming, target.extra);
        assert.equal(c.status, 200); assert.equal(c.body.choices[0].finish_reason, "stop");
        assert.match(c.body.choices[0].message.content, /client contents/); assert.match(c.body.choices[0].message.content, /ERROR/);
      });
    }

    await t.test("required selects second tool; named and none choices; structured final output", async () => {
      for (const choice of ["required", { type: "function", function: { name: "read" } }] as const) {
        const messages: ChatMessage[] = [{ role: "user", content: "SCENARIO:choice" }];
        const a = await completion(direct, messages, "choice", false, { tool_choice: choice });
        assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.choices[0].message.tool_calls[0].function.name, "read");
        const assistant = a.body.choices[0].message;
        messages.push(assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "success" });
        assert.equal((await completion(direct, messages, "choice", false)).body.choices[0].finish_reason, "stop");
      }
      const a = await completion(direct, [{ role: "user", content: "SCENARIO:none" }], "none", true, { tool_choice: "none", response_format: { type: "json_schema", json_schema: { name: "Result", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, strict: true } } });
      assert.equal(a.status, 200, JSON.stringify(a.body)); assert.deepEqual(JSON.parse(a.body.choices[0].message.content), { ok: true });
      assert.equal(a.body.choices[0].message.tool_calls, undefined);
    });

    await t.test("two independent clients, explicit cancel, TTL, duplicate/foreign results", async () => {
      const ma: ChatMessage[] = [{ role: "user", content: "SCENARIO:isolated client A" }];
      const mb: ChatMessage[] = [{ role: "user", content: "SCENARIO:isolated client B" }];
      const [a, b] = await Promise.all([completion(direct, ma, "a", false), completion(direct, mb, "b", false)]);
      const aa = a.body.choices[0].message, bb = b.body.choices[0].message;
      assert.notEqual(aa.tool_calls[0].id, bb.tool_calls[0].id);
      ma.push(aa, { role: "tool", tool_call_id: aa.tool_calls[0].id, content: "result A" });
      mb.push(bb, { role: "tool", tool_call_id: bb.tool_calls[0].id, content: "result B" });
      const [ra, rb] = await Promise.all([completion(direct, ma, "a", false), completion(direct, mb, "b", false)]);
      assert.match(ra.body.choices[0].message.content, /result A/); assert.doesNotMatch(ra.body.choices[0].message.content, /result B/);
      assert.match(rb.body.choices[0].message.content, /result B/);
      assert.equal((await completion(direct, ma, "a", false)).status, 400);
      const pending = await completion(direct, [{ role: "user", content: "SCENARIO:cancel" }], "cancel", false);
      const id = pending.body.choices[0].message.tool_calls[0].id;
      const cancelled = await fetch(`${direct}/v1/caller/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "cancel", tool_call_ids: [id] }) });
      assert.equal(cancelled.status, 200);
      assert.equal((await completion(direct, [{ role: "tool", tool_call_id: id, content: "late" }], "cancel", false)).status, 400);
      CONFIG.callerTtlMs = 50;
      const expiring = await completion(direct, [{ role: "user", content: "SCENARIO:TTL" }], "ttl", false);
      await sleep(100);
      assert.equal((await completion(direct, [{ role: "tool", tool_call_id: expiring.body.choices[0].message.tool_calls[0].id, content: "late" }], "ttl", false)).status, 400);
      CONFIG.callerTtlMs = saved.callerTtlMs;
    });

    await t.test("forbidden native shell fails closed and disconnect releases capacity", async () => {
      const blocked = await completion(direct, [{ role: "user", content: "SCENARIO:blocked" }], "blocked", false);
      assert.equal(blocked.status, 502, JSON.stringify(blocked.body));
      await assert.rejects(access(forbiddenMarker));
      CONFIG.callerMaxSessions = 1;
      const before = requests.length;
      const controller = new AbortController();
      const running = fetch(`${direct}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools, messages: [{ role: "user", content: "SCENARIO:cancel-active" }] }), signal: controller.signal }).catch(() => {});
      for (let i = 0; requests.length === before && i < 100; i++) await sleep(20);
      controller.abort(); await running; await sleep(100);
      const after = await completion(direct, [{ role: "user", content: "SCENARIO:none" }], "after", false, { tool_choice: "none" });
      assert.equal(after.status, 200, JSON.stringify(after.body));
      const earlyController = new AbortController();
      const early = fetch(`${direct}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools, messages: [{ role: "user", content: "SCENARIO:cancel-active startup" }] }), signal: earlyController.signal }).catch(() => {});
      await sleep(10); earlyController.abort(); await early;
      await CALLER_RUNTIME.drain();
      const recovered = await completion(direct, [{ role: "user", content: "SCENARIO:none" }], "recovered", false, { tool_choice: "none" });
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      CONFIG.callerMaxSessions = saved.callerMaxSessions;
    });

    if (process.env.CODEX_PROXY_TEST_OPENCODE === "1") await t.test("actual OpenCode executes bash in its own working directory", async () => {
      const { mkdir } = await import("node:fs/promises");
      const client = join(directory, "opencode-client"); await mkdir(client);
      await writeFile(join(client, "client-only.txt"), "client-side sentinel");
      const target = targets.at(-1)!;
      const provider = { npm: "@ai-sdk/openai-compatible", name: "Caller integration", options: { baseURL: `${target.url}/v1`, apiKey: "fixture-only" }, models: {} as Record<string, { name: string; limit: { context: number; output: number } }> };
      // Bifrost expects a provider prefix in the model ID.
      const modelName = target.name === "Bifrost" ? "openai/gpt-5.5" : "gpt-5.5";
      provider.models = { [modelName]: { name: "Fixture", limit: { context: 128000, output: 8192 } } };
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile("opencode", ["run", "--pure", "--format", "json", "--dir", client, "--model", `caller/${modelName}`, "Show files in the current directory using bash"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"), OPENCODE_CONFIG_DIR: join(directory, "config/opencode"), OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { caller: provider }, permission: { bash: "allow" } }), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true" } }, (error, stdout, stderr) => {
          if (error) reject(new Error(`OpenCode fixture failed: ${error.message}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`));
          else resolve({ stdout, stderr });
        });
        // OpenCode reads piped stdin before starting even when argv has a prompt.
        child.stdin?.end();
      });
      assert.match(stdout, /"type":"tool_use"/, stderr);
      assert.match(stdout, /client-only\.txt/);
      assert.match(stdout, /opencode-client/);
    });
  } finally {
    await CALLER_RUNTIME.drain();
    if (container) await exec("docker", ["rm", "-f", container]).catch(() => {});
    await close(api); await close(upstream);
    Object.assign(CONFIG, saved);
    await rm(directory, { recursive: true, force: true });
  }
});
