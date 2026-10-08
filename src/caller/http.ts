import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { CallerInferenceError } from "./inference.js";
import { CONFIG } from "../server/config.js";
import { CALLER_RUNTIME, CallerRequestError, validateCallerRequest } from "./runtime.js";
import { CodexProxyError, invalidRequestError, mapErrorToHttp } from "../server/errors.js";
import { makeChatCompletionChunk, makeChatToolCallChunk, chunkToSSE, SSE_DONE, turnResultToChatCompletion, turnResultUsageToOpenAI } from "../adapter/codex-to-openai.js";
import { annotateTurnUsage } from "../server/usage.js";
import { recordRequest } from "../server/metrics.js";
import type { ChatCompletionRequest } from "../types/openai.js";

export function callerMode(body: Pick<ChatCompletionRequest, "tool_execution_mode" | "codex_proxy">): "caller" | "hybrid" | "invalid" {
  const root = body?.tool_execution_mode;
  const extension = body?.codex_proxy?.tool_execution_mode;
  if ((root !== undefined && root !== "caller" && root !== "hybrid") ||
      (extension !== undefined && extension !== "caller" && extension !== "hybrid") ||
      (root !== undefined && extension !== undefined && root !== extension)) return "invalid";
  return root || extension || CONFIG.toolExecutionMode;
}

export async function handleCallerChat(req: Request, res: Response): Promise<void> {
  const body = req.body as ChatCompletionRequest;
  const requestId = String(res.locals.requestId || randomUUID());
  const model = body.model || CONFIG.defaultModel;
  const started = Date.now();
  const controller = new AbortController();
  let keepalive: NodeJS.Timeout | undefined;
  let status: "ok" | "error" = "error";
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  res.setHeader("X-Codex-Proxy-Tool-Execution-Mode", "caller");
  try {
    if (!Array.isArray(body.messages) || !body.messages.length) throw new CallerRequestError("messages array is required");
    validateCallerRequest(body);
    if (CONFIG.debug || CONFIG.trace) console.error(JSON.stringify({ event: "caller.request", requestId, mode: "caller", toolCount: body.tools?.length || 0 }));
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(":ok\n\n");
      if (CONFIG.keepaliveMs) {
        keepalive = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(":keepalive\n\n"); }, CONFIG.keepaliveMs);
        keepalive.unref();
      }
    }
    const result = await CALLER_RUNTIME.run(req, controller.signal);
    annotateTurnUsage(result, JSON.stringify(body.messages), model);
    const calls = result.toolCalls || [];
    if (CONFIG.debug || CONFIG.trace) console.error(JSON.stringify({ event: "caller.response", requestId, mode: "caller", toolCount: body.tools?.length || 0, returnedCallCount: calls.length }));
    if (controller.signal.aborted) return;
    if (body.stream) {
      if (result.text) res.write(chunkToSSE(makeChatCompletionChunk(requestId, model, result.text)));
      for (let i = 0; i < calls.length; i++) res.write(chunkToSSE(makeChatToolCallChunk(requestId, model, calls[i], i, null)));
      const final = makeChatCompletionChunk(requestId, model, null, "stop", turnResultUsageToOpenAI(result));
      final.choices[0].finish_reason = calls.length ? "tool_calls" : "stop";
      res.write(chunkToSSE(final)); res.write(SSE_DONE); res.end();
    } else {
      const response = turnResultToChatCompletion(result, model);
      response.id = `chatcmpl-${requestId}`;
      if (calls.length) {
        response.choices[0].message = { role: "assistant", content: result.text || null, tool_calls: calls };
        response.choices[0].finish_reason = "tool_calls";
      }
      res.json(response);
    }
    status = "ok";
  } catch (error) {
    if (controller.signal.aborted || (error instanceof CodexProxyError && error.kind === "client_closed")) return;
    if (CONFIG.debug || CONFIG.trace) console.error(JSON.stringify({ event: "caller.failure", requestId, mode: "caller", kind: error instanceof CodexProxyError ? error.kind : "request" }));
    const mapped = error instanceof CallerRequestError
      ? { status: error.status, body: { error: { ...invalidRequestError(error.message).error, code: error.code } } }
      : error instanceof CallerInferenceError
        ? { status: 502, body: { error: { type: "server_error" as const, code: error.code, message: error.message } } }
        : mapErrorToHttp(error, false);
    if (!res.headersSent) res.status(mapped.status).json(mapped.body);
    else if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(mapped.body)}\n\n`); res.write(SSE_DONE); res.end();
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    res.off("close", disconnected);
    recordRequest({ endpoint: "chat_completions", model, runtime: "oneshot", status, durationMs: Date.now() - started });
  }
}

export function handleCallerCancel(req: Request, res: Response): void {
  try { CALLER_RUNTIME.cancel(req, req.body?.tool_call_ids); res.json({ cancelled: true }); }
  catch (error) { res.status(error instanceof CallerRequestError ? error.status : 500).json(invalidRequestError(error instanceof Error ? error.message : "Cancellation failed")); }
}
