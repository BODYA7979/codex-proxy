import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { setImmediate } from "node:timers/promises";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { AVAILABLE_MODELS } from "../adapter/openai-to-codex.js";
import { getAvailableModels, refreshAvailableModels, startModelRefresh, stopModelRefresh } from "../server/models.js";
import { CONFIG } from "../server/config.js";
import { startServer, stopServer } from "../server/index.js";
import { CodexSubprocess } from "../subprocess/manager.js";
import type { ModelListResponse } from "../types/codex.js";

afterEach(() => stopModelRefresh());

function catalog(...models: string[]): ModelListResponse {
  return { data: models.map(model => ({ id: model, model })) };
}

test("refreshAvailableModels reads every page and removes duplicates", async () => {
  assert.deepEqual(getAvailableModels(), AVAILABLE_MODELS);
  const cursors: Array<string | null | undefined> = [];
  let killed = false;
  const refreshed = await refreshAvailableModels(() => ({
    async start() {},
    async listModels({ cursor }) {
      cursors.push(cursor);
      return cursor
        ? { data: [{ id: "gpt-5.6", model: "gpt-5.6" }] }
        : {
          data: [
            { id: "gpt-5.5", model: "gpt-5.5" },
            { id: "gpt-5.6", model: "gpt-5.6" },
          ],
          nextCursor: "page-2",
        };
    },
    kill() { killed = true; },
  }));

  assert.equal(refreshed, true);
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(getAvailableModels(), ["gpt-5.5", "gpt-5.6"]);
  assert.equal(killed, true);
});

test("refreshAvailableModels retains the current list and logs errors without debug", async (t) => {
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  });
  let killed = false;
  const refreshed = await refreshAvailableModels(() => ({
    async start() { throw new Error("Codex is unavailable"); },
    async listModels() { throw new Error("not reached"); },
    kill() { killed = true; },
  }));

  assert.equal(refreshed, false);
  assert.deepEqual(getAvailableModels(), ["gpt-5.5", "gpt-5.6"]);
  assert.equal(killed, true);
  assert.ok(messages.some(message => message.includes("models.refresh.error") && message.includes("Codex is unavailable")));
  assert.ok(messages.some(message => message.includes('"stage":"initialize"')));
});

test("background discovery recovers after startup failure and refreshes periodically", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(process.stderr, "write", () => true);
  let attempts = 0;
  const createClient = () => {
    const attempt = ++attempts;
    return {
      async start() {
        if (attempt === 1) throw new Error("initialize timed out");
      },
      async listModels() {
        return attempt === 2 ? catalog("gpt-6-sol") : catalog("gpt-6-sol", "gpt-6-astra");
      },
      kill() {},
    };
  };
  startModelRefresh(createClient);
  startModelRefresh(createClient);
  await setImmediate();
  assert.equal(attempts, 1);

  t.mock.timers.tick(CONFIG.modelRefreshRetryMs - 1);
  await setImmediate();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(attempts, 2);
  assert.deepEqual(getAvailableModels(), ["gpt-6-sol"]);

  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs - 1);
  await setImmediate();
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(attempts, 3);
  assert.deepEqual(getAvailableModels(), ["gpt-6-sol", "gpt-6-astra"]);

  await stopModelRefresh();
  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs * 2);
  await setImmediate();
  assert.equal(attempts, 3);
});

test("empty or partially failed catalogs retain every previously discovered model", async (t) => {
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  });
  const previous = [...getAvailableModels()];
  assert.equal(await refreshAvailableModels(() => ({
    async start() {},
    async listModels() { return catalog(); },
    kill() {},
  })), false);
  assert.deepEqual(getAvailableModels(), previous);
  assert.ok(messages.some(message => message.includes("models.refresh.empty")));

  let pages = 0;
  assert.equal(await refreshAvailableModels(() => ({
    async start() {},
    async listModels() {
      if (++pages === 2) throw new Error("second page timed out");
      return { ...catalog("gpt-6-luna"), nextCursor: "page-2" };
    },
    kill() {},
  })), false);
  assert.deepEqual(getAvailableModels(), previous);
  assert.ok(messages.some(message => message.includes("second page timed out") && message.includes('"stage":"model/list"')));
});

test("slow discovery cannot overlap background or manual refreshes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let finish!: (result: ModelListResponse) => void;
  const page = new Promise<ModelListResponse>(resolve => { finish = resolve; });
  const createClient = () => {
    attempts++;
    return {
      async start() {},
      async listModels() { return page; },
      kill() { finish(catalog()); },
    };
  };
  startModelRefresh(createClient);
  const manual = refreshAvailableModels(createClient);
  assert.equal(refreshAvailableModels(createClient), manual);
  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs * 3);
  await setImmediate();
  assert.equal(attempts, 1);
  finish(catalog("gpt-6.1-sol"));
  assert.equal(await manual, true);
  await setImmediate();
  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs);
  await setImmediate();
  assert.equal(attempts, 2);
});

test("shutdown kills active discovery and prevents late results or rescheduling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  });
  const previous = [...getAvailableModels()];
  let attempts = 0;
  let kills = 0;
  let finish!: (result: ModelListResponse) => void;
  const page = new Promise<ModelListResponse>(resolve => { finish = resolve; });
  startModelRefresh(() => {
    attempts++;
    return {
      async start() {},
      async listModels() { return page; },
      kill() { kills++; finish(catalog("late-model")); },
    };
  });
  await setImmediate();
  await stopModelRefresh();
  assert.ok(kills > 0);
  assert.deepEqual(getAvailableModels(), previous);
  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs * 2);
  await setImmediate();
  assert.equal(attempts, 1);
  assert.ok(messages.every(message => !message.includes("models.refresh.error")));
});

test("client construction errors are logged and do not prevent retrying", async (t) => {
  t.mock.method(process.stderr, "write", () => true);
  assert.equal(await refreshAvailableModels(() => { throw new Error("spawn failed"); }), false);
  assert.equal(await refreshAvailableModels(() => ({
    async start() {},
    async listModels() { return catalog("gpt-6-sol"); },
    kill() {},
  })), true);
});

test("HTTP model lists recover and refresh on the same server, then stop with it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(process.stderr, "write", () => true);
  const initPool = CONFIG.initPool;
  CONFIG.initPool = false;
  t.after(async () => {
    await stopServer();
    CONFIG.initPool = initPool;
  });
  let attempts = 0;
  t.mock.method(CodexSubprocess.prototype, "start", async () => {
    if (++attempts === 1) throw new Error("temporary startup failure");
    return { userAgent: "fixture" };
  });
  t.mock.method(CodexSubprocess.prototype, "listModels", async () => attempts === 2
    ? catalog("gpt-6-sol") : catalog("gpt-6.1-sol", "gpt-6-astra"));
  t.mock.method(CodexSubprocess.prototype, "kill", () => {});
  const previous = [...getAvailableModels()];
  const { server } = await startServer({ host: "127.0.0.1", port: 0 });
  const port = (server.address() as AddressInfo).port;
  const modelIds = (path: string) => new Promise<string[]>((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path, agent: false }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try {
          assert.equal(response.statusCode, 200);
          resolve(JSON.parse(body).data.map((model: { id: string }) => model.id));
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
  });

  await setImmediate();
  assert.deepEqual(await modelIds("/v1/models"), previous);
  t.mock.timers.tick(CONFIG.modelRefreshRetryMs);
  await setImmediate();
  assert.deepEqual(await modelIds("/v1/models"), ["gpt-6-sol"]);
  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs);
  await setImmediate();
  assert.deepEqual(await modelIds("/models"), ["gpt-6.1-sol", "gpt-6-astra"]);

  await stopServer();
  t.mock.timers.tick(CONFIG.modelRefreshIntervalMs * 2);
  await setImmediate();
  assert.equal(attempts, 3);
});
