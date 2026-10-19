import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG } from "../server/config.js";
import { logError, trace } from "../server/trace.js";

test("operational errors are visible and sanitized while verbose tracing is disabled", (t) => {
  const previous = { debug: CONFIG.debug, trace: CONFIG.trace };
  CONFIG.debug = false;
  CONFIG.trace = false;
  t.after(() => Object.assign(CONFIG, previous));
  const messages: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  });

  trace("http.request.start", { prompt: "not for operational logs" });
  logError("models.refresh.error", new Error("initialize failed: Bearer example-secret-value-123456"), {
    stage: "initialize",
    authorization: "private-credential",
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /^\[codex-proxy:error\]/);
  assert.match(messages[0], /models\.refresh\.error/);
  assert.match(messages[0], /initialize failed/);
  assert.match(messages[0], /\[REDACTED\]/);
  assert.doesNotMatch(messages[0], /example-secret-value|private-credential|not for operational logs/);
});
