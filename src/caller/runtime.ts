import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { CodexSubprocess, type TurnResult, type CodexSubprocessOptions } from "../subprocess/manager.js";
import type { ChatCompletionRequest, ChatCompletionToolCall, ChatCompletionTool, ResponseOutputItem } from "../types/openai.js";
import { chatMessagesToPrompt } from "../adapter/openai-to-codex.js";
import { CONFIG } from "../server/config.js";
import { CodexProxyError, mapErrorToHttp } from "../server/errors.js";
import type { RequestId } from "../types/codex.js";
import { linkCallerCredentials } from "./credentials.js";
import { CALLER_PERMISSION_INSTRUCTIONS } from "./policy.js";
import { CallerInference, CallerInferenceError, type ModelToolCall } from "./inference.js";

export type CallerResult = TurnResult & { toolCalls?: ChatCompletionToolCall[]; outputItems?: ResponseOutputItem[] };

import { CallerRequestError } from "./errors.js";
export { CallerRequestError } from "./errors.js";

export function validateCallerRequest(body: ChatCompletionRequest): void {
  const names = new Set<string>();
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new CallerRequestError("tools must be an array");
  for (const tool of body.tools || []) {
    if (tool?.type !== "function" || !tool.function || typeof tool.function.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name)) {
      throw new CallerRequestError("caller mode requires named function tools (1–64 letters, digits, underscores or hyphens)");
    }
    if (names.has(tool.function.name)) throw new CallerRequestError("Duplicate function tool name");
    names.add(tool.function.name);
    if (tool.function.parameters !== undefined && (!tool.function.parameters || typeof tool.function.parameters !== "object" || Array.isArray(tool.function.parameters))) {
      throw new CallerRequestError("Function parameters must be a JSON Schema object");
    }
  }
  const choice = body.tool_choice;
  if (choice !== undefined && !["auto", "none", "required"].includes(choice as string)) {
    if (!choice || typeof choice !== "object" || choice.type !== "function" || !names.has(choice.function?.name)) {
      throw new CallerRequestError("tool_choice must select a supplied function");
    }
  }
  if (choice === "required" && !names.size) throw new CallerRequestError("tool_choice required needs at least one tool");
  if (body.codex_proxy?.mode === "sticky" || body.codex_proxy?.session_mode === "sticky" || body.codex_proxy?.sessionMode === "sticky") {
    throw new CallerRequestError("caller mode uses tool_call_id correlation; sticky sessions are unsupported");
  }
  if (!body.messages.every(message => message && typeof message === "object" && ["system", "developer", "user", "assistant", "tool"].includes(message.role)
      && (message.content === null || typeof message.content === "string" || Array.isArray(message.content)
        // OpenAI-compatible gateways omit null content on tool-only messages.
        || (message.content === undefined && message.role === "assistant" && Array.isArray(message.tool_calls)
          && message.tool_calls.length > 0 && message.tool_calls.every(call => call?.type === "function"
            && typeof call.id === "string" && call.id.length > 0
            && typeof call.function?.name === "string" && call.function.name.length > 0
            && typeof call.function.arguments === "string")))
      && (message.role !== "tool" || (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0)))) {
    throw new CallerRequestError("Invalid messages");
  }
}

export function callerIdentity(req: Request): string {
  // A shared Bifrost credential alone is not a user identity. Forward a distinct
  // client-id (or OpenAI user) for each tenant; anonymous IDs are bearer capabilities.
  return createHash("sha256").update(JSON.stringify([
    req.header("authorization") || "", req.header("x-codex-proxy-client-id") || "", req.body.user || "",
  ])).digest("hex");
}

function catalog(tools: ChatCompletionTool[] | undefined): string { return JSON.stringify(tools || []); }

interface PendingCall { wire: ChatCompletionToolCall; modelId: string; rpcId?: RequestId; result?: string }

class CallerSession {
  readonly id = randomUUID();
  readonly worker = new CodexSubprocess();
  readonly calls = new Map<string, PendingCall>();
  readonly inference: CallerInference;
  directory?: string;
  timer?: NodeJS.Timeout;
  text = "";
  sentText = 0;
  modelTurnId: string = this.id;
  busy = true;
  closed = false;
  lastContinuationIds: string[] = [];
  private done?: TurnResult;
  private failure?: Error;
  private wake?: () => void;
  private ready = false;
  private cleanupStarted = false;
  constructor(readonly owner: string, readonly model: string, readonly tools: ChatCompletionTool[], private readonly forget: () => void, private readonly trackCleanup: (cleanup: Promise<void>) => void, readonly nativeTools = false, readonly responses = false) {
    this.inference = new CallerInference(tools, CONFIG.callerUpstream, calls => this.capture(calls), error => this.fail(error), nativeTools, responses);
  }

  private capture(calls: ModelToolCall[]): void {
    if (this.calls.size) { this.fail(new Error("Caller received overlapping tool batches")); return; }
    for (const call of calls) {
      const id = `call_${randomUUID().replace(/-/g, "")}`;
      this.calls.set(id, { modelId: call.callId, wire: { id, type: "function", function: { name: call.name, arguments: call.arguments } } });
    }
  }

  private handleTool(request: { id: RequestId; params: Record<string, unknown> }): void {
    const pending = [...this.calls.values()].find(call => call.modelId === request.params.callId);
    const index = this.tools.findIndex(tool => tool.function.name === pending?.wire.function.name);
    if (!pending || request.params.tool !== `caller_tool_${index}` || request.params.namespace != null || pending.rpcId !== undefined) {
      this.fail(new Error("Unexpected caller dynamic tool request")); return;
    }
    pending.rpcId = request.id;
    this.modelTurnId = String(request.params.turnId);
    if (pending.result !== undefined) {
      this.worker.respondToCallerTool(request.id, pending.result);
      this.finishBatchIfAnswered();
    }
    else {
      this.ready = true;
      this.wake?.();
    }
  }

  async start(body: ChatCompletionRequest): Promise<void> {
    if (this.closed) throw new CodexProxyError("client_closed", "Caller cancelled");
    this.inference.setChoice(body.tool_choice);
    this.inference.setParallel(body.parallel_tool_calls);
    if (this.responses) this.inference.setClientInstructions(body.messages.filter(message => message.role === "system" || message.role === "developer").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"));
    this.inference.setResponseFormat(body.response_format);
    this.directory = await mkdtemp(join(tmpdir(), "codex-proxy-caller-"));
    if (this.closed) { this.close(); throw new CodexProxyError("client_closed", "Caller cancelled"); }
    // Only the official app-server reads shared credentials. User configuration
    // and project content stay outside the isolated home and working directory.
    await linkCallerCredentials(process.env.CODEX_HOME || join(homedir(), ".codex"), this.directory);
    if (this.closed) throw new CodexProxyError("client_closed", "Caller cancelled");
    const baseUrl = await this.inference.start();
    if (this.closed) throw new CodexProxyError("client_closed", "Caller cancelled");
    const { prompt, systemInstruction, imageInputs } = chatMessagesToPrompt(body.messages);
    const instructions = [this.responses ? undefined : systemInstruction, this.nativeTools ? "External function tools execute on the client; native Codex tools execute in the proxy environment. Keep their paths and permissions separate. Return assistant text separately from calls." : CALLER_PERMISSION_INSTRUCTIONS, this.nativeTools ? undefined : "You are responding to an external client. Use the supplied caller tools for all operations. Their paths and working directory belong to the client. Tool results can require further calls. Return ordinary assistant text separately from tool calls."].filter(Boolean).join("\n");
    const options: CodexSubprocessOptions = {
      model: this.model, cwd: this.directory, instructions,
      reasoningEffort: body.reasoning_effort || undefined,
      timeoutMs: CONFIG.defaultTimeoutMs, initTimeoutMs: CONFIG.initTimeoutMs, turnStartTimeoutMs: CONFIG.turnStartTimeoutMs,
      // Codex treats outputSchema as strict Structured Outputs, not JSON mode.
      // Arbitrary JSON objects use instructions plus final-answer validation.
      outputSchema: body.response_format?.type === "json_schema" ? body.response_format.json_schema.schema : undefined,
      envOverrides: { CODEX_HOME: this.directory },
      configOverrides: {
        model_provider: '"caller"',
        // Harness compaction uses OpenAI provider identity. The localhost base
        // URL still enforces caller-only execution before any output reaches it.
        'model_providers.caller.name': '"OpenAI"',
        'model_providers.caller.base_url': JSON.stringify(baseUrl),
        'model_providers.caller.wire_api': '"responses"',
        'model_providers.caller.requires_openai_auth': "true",
        'model_providers.caller.supports_websockets': "false",
        'features.enable_request_compression': "false",
        ...(this.nativeTools ? {} : {
        'features.shell_tool': "false", 'features.unified_exec': "false",
        'features.plugins': "false", 'features.apps': "false", 'features.hooks': "false",
        'features.multi_agent': "false", 'features.multi_agent_v2': "false",
        'features.code_mode': "false", 'features.code_mode_host': "false",
        'features.memories': "false", 'features.goals': "false", 'web_search': '"disabled"',
          }),
      },
      caller: {
        nativeTools: this.nativeTools,
        dynamicTools: this.tools.map((tool, i) => ({ type: "function", name: `caller_tool_${i}`, description: `Caller tool ${tool.function.name}: ${tool.function.description || ""}`, inputSchema: tool.function.parameters || { type: "object", properties: {} } })),
        onToolCall: request => this.handleTool(request),
      },
    };
    await this.worker.start(options);
    if (this.closed) { this.worker.kill(); throw new CodexProxyError("client_closed", "Caller cancelled"); }
    void this.worker.submitTurn(prompt, options, delta => { this.text += delta; }, undefined, imageInputs.map(image => image.url)).then(
      result => { this.done = result; this.wake?.(); }, error => this.fail(error),
    );
  }

  resume(body: ChatCompletionRequest, outputs: Array<{ id: string; text: string }>): void {
    this.inference.setChoice(body.tool_choice);
    this.inference.setParallel(body.parallel_tool_calls);
    if (this.responses) this.inference.setClientInstructions(body.messages.filter(message => message.role === "system" || message.role === "developer").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"));
    if (this.responses) this.inference.setResponseFormat(body.response_format);
    this.ready = false;
    // Keep the batch until every deferred RPC has received its corresponding
    // result; sequential harness dispatch is supported as well as parallel dispatch.
    for (const output of outputs) this.calls.get(output.id)!.result = output.text;
    for (const call of this.calls.values()) {
      if (call.rpcId !== undefined) this.worker.respondToCallerTool(call.rpcId, call.result!);
    }
  }

  async segment(): Promise<CallerResult> {
    while (!this.ready && !this.done && !this.failure) await new Promise<void>(resolve => { this.wake = resolve; });
    this.wake = undefined;
    if (this.failure) throw this.failure;
    const text = this.text.slice(this.sentText);
    this.sentText = this.text.length;
    if (this.done) {
      try { this.inference.validateFinalText(text); }
      catch (error) { this.fail(error as Error); throw error; }
      return { ...this.done, text };
    }
    const outputItems: ResponseOutputItem[] = [];
    if (this.responses) for (const item of this.inference.output) {
      if (item.type === "message") {
        const content = (Array.isArray(item.content) ? item.content : []) as Array<{ type: string; text?: string }>;
        const messageText = content.filter(part => part.type === "output_text").map(part => part.text || "").join("");
        if (messageText) outputItems.push({ type: "message", id: `msg_${randomUUID().replace(/-/g, "")}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: messageText, annotations: [] }] });
      } else if (item.type === "function_call") {
        const pending = [...this.calls.values()].find(call => call.modelId === item.call_id);
        if (pending) outputItems.push({ type: "function_call", id: `fc_${randomUUID().replace(/-/g, "")}`, call_id: pending.wire.id, name: pending.wire.function.name, arguments: pending.wire.function.arguments, status: "completed" });
      }
    }
    return { text, turnId: this.modelTurnId, threadId: this.id, usage: null, durationMs: null, finishReason: "stop", toolCalls: [...this.calls.values()].map(call => call.wire), ...(this.responses ? { outputItems } : {}) };
  }

  finishBatchIfAnswered(): void {
    if (this.calls.size && [...this.calls.values()].every(call => call.result !== undefined && call.rpcId !== undefined)) this.calls.clear();
  }

  get failureReason(): Error | undefined { return this.failure; }
  fail(error: Error): void {
    if (this.failure || this.closed) return;
    const reason = error instanceof CodexProxyError && (error.kind === "codex" || error.kind === "protocol") ? this.inference.lastFailure || error : error;
    this.failure = reason instanceof CodexProxyError ? reason : new CodexProxyError("protocol", "Caller tool bridge failed", { cause: reason });
    this.wake?.(); this.close();
  }
  close(): void {
    const wasClosed = this.closed;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.worker.kill(); this.inference.close();
    if (!wasClosed) this.forget();
    if (!this.failure && !this.done) this.failure = new CodexProxyError("client_closed", "Caller cancelled");
    this.wake?.();
    // Wait for app-server to release files and stop recreating its state before
    // deleting the isolated home. Shutdown awaits these tracked cleanups.
    if (this.directory && !this.cleanupStarted) {
      this.cleanupStarted = true;
      const directory = this.directory;
      this.trackCleanup(this.worker.waitForExit().then(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })));
    }
  }
}

export function supportsCallerVersion(version: string): boolean {
  const match = version.match(/codex-cli (\d+)\.(\d+)\.(\d+)(?:-([^\s]+))?/);
  if (!match) return false;
  const [, major, minor, patch, prerelease] = match;
  if (Number(major) > 0 || Number(minor) > 162 || (Number(minor) === 162 && Number(patch) > 0)) return true;
  if (Number(minor) !== 162) return false;
  if (!prerelease) return true;
  if (/^(beta|rc)(\.|$)/.test(prerelease)) return true;
  const alpha = prerelease.match(/^alpha\.(\d+)(?:\.\d+)*$/);
  return Boolean(alpha && Number(alpha[1]) >= 2);
}

export class CallerRuntime {
  private readonly sessions = new Set<CallerSession>();
  private readonly pending = new Map<string, CallerSession>();
  private versionCheck?: Promise<void>;
  private readonly cleanups = new Set<Promise<void>>();
  // Retain only safe failure metadata for SDK retries, never tool outputs or
  // credentials. A failed continuation must not masquerade as an unknown ID.
  private readonly failures = new Map<string, { owner: string; expiresAt: number; code: string; message: string }>();
  private async checkVersion(): Promise<void> {
    this.versionCheck ||= promisify(execFile)(CONFIG.codexBin, ["--version"], { timeout: CONFIG.initTimeoutMs }).then(({ stdout }) => {
      if (!supportsCallerVersion(stdout)) throw new CallerRequestError("caller mode requires Codex app-server 0.162.0-alpha.2 or newer", 503);
    });
    return this.versionCheck;
  }

  async run(req: Request, signal: AbortSignal, options: { body?: ChatCompletionRequest; replay?: boolean; nativeTools?: boolean; responses?: boolean } = {}): Promise<CallerResult> {
    const body = options.body || req.body as ChatCompletionRequest;
    validateCallerRequest(body);
    for (const [id, receipt] of this.failures) if (receipt.expiresAt <= Date.now()) this.failures.delete(id);
    const trailing = [];
    for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) trailing.unshift(body.messages[i]);
    let session: CallerSession;
    const replay = options.replay && trailing.length && !this.pending.has(trailing[0].tool_call_id || "") && trailing.every(output => body.messages.some(message => message.tool_calls?.some(call => call.id === output.tool_call_id)));
    if (replay) {
      const receipt = this.failures.get(trailing[0].tool_call_id || "");
      if (receipt?.owner === callerIdentity(req)) throw new CallerRequestError(`Previous caller continuation failed: ${receipt.message}`, 409, receipt.code);
    }
    if (trailing.length && !replay) {
      const found = this.pending.get(trailing[0].tool_call_id || "");
      if (!found) {
        const receipt = this.failures.get(trailing[0].tool_call_id || "");
        if (receipt?.owner === callerIdentity(req)) throw new CallerRequestError(`Previous caller continuation failed: ${receipt.message}`, 409, receipt.code);
        throw new CallerRequestError("Unknown, expired or foreign tool_call_id");
      }
      if (found.owner !== callerIdentity(req)) throw new CallerRequestError("Unknown, expired or foreign tool_call_id");
      session = found;
      if (session.busy) throw new CallerRequestError("Caller continuation is already active", 409);
      if (session.nativeTools !== !!options.nativeTools || session.responses !== !!options.responses) throw new CallerRequestError("Continuation must preserve execution mode and API endpoint");
      if (session.model !== (body.model || CONFIG.defaultModel) || catalog(session.tools) !== catalog(body.tools)) throw new CallerRequestError("Caller continuation must preserve model and tool definitions");
      const ids = trailing.map(message => message.tool_call_id || "");
      if (new Set(ids).size !== session.calls.size || ids.length !== session.calls.size || ids.some(id => !session.calls.has(id))) throw new CallerRequestError("Return exactly one result for every pending tool_call_id");
      session.busy = true;
      session.lastContinuationIds = ids;
      if (session.timer) clearTimeout(session.timer);
      for (const id of ids) this.pending.delete(id);
      const outputs = trailing.map(message => ({ id: message.tool_call_id!, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }));
      session.resume(body, outputs);
      session.finishBatchIfAnswered();
    } else {
      // Unanswered assistant calls must not be silently replayed in a new thread.
      if (body.messages.at(-1)?.role === "assistant" && body.messages.at(-1)?.tool_calls?.length) throw new CallerRequestError("Tool results are required to continue");
      if (this.sessions.size + this.cleanups.size >= CONFIG.callerMaxSessions) throw new CallerRequestError("Caller session capacity reached; retry after a pending call completes or expires", 429);
      session = new CallerSession(callerIdentity(req), body.model || CONFIG.defaultModel, body.tools || [], () => {
        this.sessions.delete(session);
        if (session.failureReason && session.lastContinuationIds.length) {
          const reason = session.failureReason;
          const safe = reason instanceof CallerInferenceError ? { code: reason.code, message: reason.message } : mapErrorToHttp(reason, false).body.error;
          for (const id of session.lastContinuationIds) this.failures.set(id, { owner: session.owner, expiresAt: Date.now() + Math.min(CONFIG.callerTtlMs, 300_000), code: safe.code, message: safe.message });
          while (this.failures.size > CONFIG.callerMaxSessions * 8) this.failures.delete(this.failures.keys().next().value!);
        }
        for (const [id, owner] of this.pending) if (owner === session) this.pending.delete(id);
      }, cleanup => {
        this.cleanups.add(cleanup);
        void cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {
          if (CONFIG.debug || CONFIG.trace) console.error(JSON.stringify({ event: "caller.cleanup_failed", mode: "caller" }));
        });
      }, !!options.nativeTools, !!options.responses);
      this.sessions.add(session);
    }
    const abort = () => session.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new CodexProxyError("client_closed", "Caller cancelled");
      if (!session.directory) { await this.checkVersion(); await session.start(body); }
      const result = await session.segment();
      if (result.toolCalls?.length) {
        session.lastContinuationIds = [];
        session.busy = false;
        for (const call of result.toolCalls) this.pending.set(call.id, session);
        session.timer = setTimeout(() => session.close(), CONFIG.callerTtlMs);
        session.timer.unref();
      } else session.close();
      return result;
    } catch (error) { session.close(); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }

  cancel(req: Request, ids: unknown): void {
    if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === "string")) throw new CallerRequestError("tool_call_ids must be a non-empty array of strings");
    const sessions = ids.map(id => this.pending.get(id));
    if (sessions.some(session => !session || session.owner !== callerIdentity(req))) throw new CallerRequestError("Unknown, expired or foreign tool_call_id");
    for (const session of new Set(sessions)) session!.close();
  }

  async drain(): Promise<void> {
    for (const session of this.sessions) session.close();
    await Promise.allSettled([...this.cleanups]);
    this.failures.clear();
  }
}

export const CALLER_RUNTIME = new CallerRuntime();
