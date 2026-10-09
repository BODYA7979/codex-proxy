import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { ResponseRequest, ResponseObject, ResponseOutputItem } from "../types/openai.js";
import type { TurnResult } from "../subprocess/manager.js";
import { CALLER_RUNTIME, CallerRequestError, callerIdentity, type CallerResult } from "../caller/runtime.js";
import { CallerInferenceError } from "../caller/inference.js";
import { callerMode } from "../caller/http.js";
import { CONFIG } from "../server/config.js";
import { resolveModel } from "../adapter/openai-to-codex.js";
import { turnResultToResponseObject, makeResponseStreamEvent } from "../adapter/codex-to-openai.js";
import { invalidRequestError, mapErrorToHttp, CodexProxyError } from "../server/errors.js";
import { annotateTurnUsage } from "../server/usage.js";
import { resolveSessionOptions } from "../server/sticky-options.js";
import { resolveRuntime } from "../subprocess/runtime.js";
import { recordRequest, incCounter } from "../server/metrics.js";
import { ResponseState, type PreparedResponse } from "./state.js";
import { compileToolSchemas } from "../adapter/function-tools.js";
import { normalizeInput, normalizeResponsesTools, responsesToChat, responseTools } from "./validation.js";

export const RESPONSE_STATE = new ResponseState(() => ({ ttl: CONFIG.callerTtlMs, entries: CONFIG.callerMaxSessions * 8, bytes: 32 * 1024 * 1024, historyBytes: 1024 * 1024 }));
const sweep = setInterval(() => RESPONSE_STATE.sweep(), 30_000); sweep.unref();
export type NativeResponseRunner = (body: ResponseRequest, signal: AbortSignal, delta?: (text: string) => void) => Promise<TurnResult>;

/** Emit a completed item with the official event fields. External tool arguments
 * are buffered and validated before any item or text is released. */
export function emitResponseItem(item: ResponseOutputItem, index: number, emit: (type: string, data: Record<string, unknown>) => void, textStarted = false): void {
  if (item.type === "function_call") {
    emit("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", arguments: "" } });
    emit("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: item.arguments });
    emit("response.function_call_arguments.done", { item_id: item.id, output_index: index, name: item.name, arguments: item.arguments });
  } else {
    const part = item.content[0];
    if (!textStarted) {
      emit("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      if (part?.type === "output_text" && part.text) emit("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: part.text, logprobs: [] });
    }
    if (part?.type === "output_text") emit("response.output_text.done", { item_id: item.id, output_index: index, content_index: 0, text: part.text, logprobs: [] });
    emit("response.content_part.done", { item_id: item.id, output_index: index, content_index: 0, part });
  }
  emit("response.output_item.done", { output_index: index, item });
}

export async function handleResponsesRequest(req: Request, res: Response, native: NativeResponseRunner): Promise<void> {
  const body = req.body as ResponseRequest;
  const mode = callerMode(body);
  const requestId = String(res.locals.requestId || randomUUID());
  // Request IDs are caller supplied and may repeat. Response IDs must not.
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const messageId = `msg_${responseId}_0`;
  const started = Date.now();
  let model = resolveModel(body.model), status: "ok" | "error" = "error", stage = "request_parsing";
  let prepared: PreparedResponse | undefined, keepalive: NodeJS.Timeout | undefined;
  let initial: ResponseObject | undefined;
  let sequence = 0, available = 0;
  let outstanding: string[] = [];
  const controller = new AbortController();
  const cancelPending = () => { if (outstanding.length) { try { CALLER_RUNTIME.cancel(req, outstanding); } catch { /* Already expired/closed. */ } outstanding = []; } };
  const disconnected = () => { if (!res.writableEnded) { controller.abort(); cancelPending(); } };
  res.on("close", disconnected);
  const diagnostic = (event: string, extra: Record<string, unknown> = {}) => {
    if (CONFIG.debug || CONFIG.trace) console.error(JSON.stringify({ event, requestId, endpoint: "responses", responseId, model, mode, stage, availableToolCount: available, ...extra }));
  };
  const emit = (type: string, data: Record<string, unknown>) => {
    if (!res.destroyed && !res.writableEnded) res.write(makeResponseStreamEvent(type, { ...data, sequence_number: sequence++ }));
  };
  try {
    if (mode === "invalid") throw new CallerRequestError("tool_execution_mode must be caller or hybrid", 400, "unsupported_tool_execution_mode");
    // Explicit unsupported features never masquerade as successful responses.
    const raw = body as unknown as Record<string, unknown>;
    const supported = new Set(["model", "input", "stream", "reasoning", "instructions", "temperature", "top_p", "max_output_tokens", "user", "tools", "tool_choice", "parallel_tool_calls", "text", "store", "response_format", "previous_response_id", "metadata", "codex_proxy", "tool_execution_mode", "background", "conversation", "include", "truncation"]);
    for (const key of Object.keys(raw)) if (!supported.has(key)) throw new CallerRequestError(`Unsupported Responses option: ${key}`, 400, "unsupported_parameter");
    for (const key of ["background", "conversation", "include", "truncation"]) if (raw[key] !== undefined && raw[key] !== false && raw[key] !== null && !(key === "include" && Array.isArray(raw[key]) && !raw[key].length) && !(key === "truncation" && raw[key] === "disabled")) throw new CallerRequestError(`Unsupported Responses option: ${key}`, 400, "unsupported_parameter");
    stage = "tool_normalization";
    const tools = normalizeResponsesTools(body);
    const incoming = normalizeInput(body.input);
    stage = "session_continuation";
    prepared = RESPONSE_STATE.prepare(callerIdentity(req), body, incoming, model, tools, mode);
    model = prepared.model; available = prepared.tools.length;
    stage = "request_parsing";
    const chat = responsesToChat({ ...body, ...prepared.execution, model }, prepared.input, prepared.tools);
    const bridge = mode === "caller" || !!prepared.tools.length || !!prepared.pending;
    const session = resolveSessionOptions(req, CONFIG);
    if (session.kind === "invalid") throw new CallerRequestError(session.message);
    if (bridge && session.options.mode === "sticky") throw new CallerRequestError("External tool continuation uses call_id/previous_response_id; sticky workers are unsupported");
    const effective: ResponseRequest = { ...body, input: prepared.input, model, tools: [], tool_choice: "none", response_format: chat.response_format, text: undefined };
    res.setHeader("X-Codex-Proxy-Tool-Execution-Mode", mode);
    initial = {
      id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [], error: null, incomplete_details: null,
      instructions: body.instructions ?? null, previous_response_id: body.previous_response_id ?? null, metadata: body.metadata ?? {},
      tools: responseTools(prepared.tools), tool_choice: body.tool_choice || "auto", parallel_tool_calls: body.parallel_tool_calls !== false,
      text: { format: chat.response_format?.type === "json_schema"
        ? { type: "json_schema", name: chat.response_format.json_schema.name || "answer", schema: chat.response_format.json_schema.schema || {}, strict: chat.response_format.json_schema.strict }
        : { type: chat.response_format?.type || "text" } }, reasoning: prepared.execution.reasoning ?? null, usage: null, store: body.store !== false,
      temperature: body.temperature ?? null, top_p: body.top_p ?? null, max_output_tokens: body.max_output_tokens ?? null,
    };
    diagnostic("responses.request");
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders();
      res.write(":ok\n\n");
      emit("response.created", { response: initial }); emit("response.in_progress", { response: initial });
      if (CONFIG.keepaliveMs) { keepalive = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(":keepalive\n\n"); }, CONFIG.keepaliveMs); keepalive.unref(); }
    }
    let textStarted = false;
    const onDelta = body.stream && !bridge ? (text: string) => {
      if (!textStarted) {
        emit("response.output_item.added", { output_index: 0, item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] } });
        emit("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); textStarted = true;
      }
      emit("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: text, logprobs: [] });
    } : undefined;
    stage = "codex_execution";
    const result: CallerResult = bridge
      ? await CALLER_RUNTIME.run(req, controller.signal, { body: chat, replay: !prepared.pending, nativeTools: mode === "hybrid", responses: true })
      : await native(effective, controller.signal, onDelta);
    if (!bridge && chat.response_format && chat.response_format.type !== "text") {
      let value: unknown;
      try { value = JSON.parse(result.text); } catch { throw new CallerInferenceError("caller_invalid_structured_output", "Final answer is not valid JSON"); }
      if (chat.response_format.type === "json_object" && (!value || typeof value !== "object" || Array.isArray(value))) throw new CallerInferenceError("caller_invalid_json_object", "Final answer must be a JSON object");
      if (chat.response_format.type === "json_schema") {
        const validate = compileToolSchemas([{ type: "function", function: { name: "answer", parameters: chat.response_format.json_schema.schema } }]).get("answer")!;
        if (!validate(value)) throw new CallerInferenceError("caller_invalid_structured_output", "Final answer does not match text.format schema");
      }
    }
    outstanding = result.toolCalls?.map(call => call.id) || [];
    if (controller.signal.aborted) { cancelPending(); return; }
    annotateTurnUsage(result, JSON.stringify(prepared.input), model);
    stage = "response_serialization";
    const response: ResponseObject = { ...initial, ...turnResultToResponseObject(result, model, { responseId, outputId: messageId }), created_at: initial.created_at };
    if (result.outputItems) {
      if (result.outputItems.filter(item => item.type === "function_call").length !== outstanding.length) throw new CallerInferenceError("caller_incomplete_function_call", "Function-call conversion lost an output item");
      response.output = result.outputItems;
    }
    else if (result.toolCalls?.length) {
      response.output = result.text ? response.output : [];
      response.output.push(...result.toolCalls.map(call => ({ type: "function_call" as const, id: `fc_${randomUUID().replace(/-/g, "")}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed" as const })));
    }
    response.output = response.output.map((item, index) => item.type === "message" ? { ...item, id: `msg_${responseId}_${index}`, content: item.content.map(part => part.type === "output_text" ? { ...part, annotations: part.annotations || [] } : part) } : item);
    response.output_text = response.output.filter(item => item.type === "message").flatMap(item => item.content).map(part => part.type === "output_text" ? part.text : "").join("");
    if (response.status === "failed") throw new CodexProxyError("codex", "Codex response failed");
    prepared.commit(responseId, response.output);
    diagnostic("responses.response", { emittedToolCallCount: outstanding.length, callIds: outstanding, threadId: result.threadId, turnId: result.turnId });
    if (body.stream) { response.output.forEach((item, index) => emitResponseItem(item, index, emit, textStarted && index === 0)); emit("response.completed", { response }); res.end(); }
    else res.json(response);
    status = "ok";
  } catch (error) {
    cancelPending();
    if (controller.signal.aborted || (error instanceof CodexProxyError && error.kind === "client_closed")) return;
    const mapped = error instanceof CallerRequestError
      ? { status: error.status, body: { error: { ...invalidRequestError(error.message).error, code: error.code } } }
      : error instanceof CallerInferenceError ? { status: 502, body: { error: { type: "server_error", code: error.code, message: error.message } } } : mapErrorToHttp(error, false);
    incCounter("codex_proxy_errors_total", { endpoint: "responses", model });
    diagnostic("responses.failure", { code: mapped.body.error.code, streaming: !!body.stream });
    if (!res.headersSent) res.status(mapped.status).json(mapped.body);
    else { emit("response.failed", { response: { ...initial, status: "failed", error: { code: mapped.body.error.code, message: mapped.body.error.message } } }); res.end(); }
  } finally {
    prepared?.release(); if (keepalive) clearInterval(keepalive); res.off("close", disconnected);
    recordRequest({ endpoint: "responses", model, runtime: bridgeRuntime(req, mode, available), status, durationMs: Date.now() - started });
  }
}

function bridgeRuntime(req: Request, mode: string, tools: number): "pool" | "oneshot" { return mode === "caller" || tools > 0 ? "oneshot" : resolveRuntime(req, CONFIG); }
