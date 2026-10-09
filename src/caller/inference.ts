import { createServer, type Server } from "node:http";
import { CodexProxyError } from "../server/errors.js";
import { compileToolSchemas } from "../adapter/function-tools.js";
import type { ValidateFunction } from "ajv";
import { CALLER_PERMISSION_INSTRUCTIONS, isCompactionRequest } from "./policy.js";
import type { ChatCompletionRequest, ChatCompletionTool } from "../types/openai.js";

export interface ModelToolCall { callId: string; name: string; arguments: string }

export class CallerInferenceError extends CodexProxyError {
  constructor(readonly code: string, message: string, readonly upstreamStatus?: number) {
    super("protocol", message);
  }
}

/** The execution boundary: app-server only receives allowlisted function calls.
 * It cannot see a native/custom/hosted tool call, even from a misbehaving model.
 */
export class CallerInference {
  private server?: Server;
  private readonly controllers = new Set<AbortController>();
  private choice: ChatCompletionRequest["tool_choice"];
  private jsonObject = false;
  private parallel = true;
  private clientInstructions = "";
  private finalValidator?: ValidateFunction;
  private validators?: Map<string, ValidateFunction>;
  output: Record<string, unknown>[] = [];
  lastFailure?: CallerInferenceError;
  constructor(
    readonly tools: ChatCompletionTool[],
    private readonly upstream: string,
    private readonly onCalls: (calls: ModelToolCall[]) => void,
    private readonly onFailure: (error: Error) => void,
    private readonly nativeTools = false,
    private readonly responses = false,
  ) {}

  setChoice(choice: ChatCompletionRequest["tool_choice"]): void { this.choice = choice; }

  setParallel(value: boolean | undefined): void { this.parallel = value !== false; }
  setClientInstructions(value: string): void { this.clientInstructions = value; }

  setResponseFormat(format: ChatCompletionRequest["response_format"]): void {
    this.jsonObject = format?.type === "json_object";
    this.finalValidator = this.responses && format?.type === "json_schema"
      ? compileToolSchemas([{ type: "function", function: { name: "answer", parameters: format.json_schema.schema } }]).get("answer") : undefined;
  }

  validateFinalText(text: string): void {
    if (!this.jsonObject && !this.finalValidator) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { /* Report a static error without model output. */ }
    if (this.finalValidator && !this.finalValidator(value)) throw new CallerInferenceError("caller_invalid_structured_output", "Caller final answer does not match text.format schema");
    if (this.jsonObject && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new CallerInferenceError("caller_invalid_json_object", "Caller final answer must be a valid JSON object");
    }
  }

  rewriteRequest(body: Record<string, unknown>): Record<string, unknown> {
    const externalTools = this.tools.map((tool, i) => ({
      type: "function", name: `caller_tool_${i}`, description: `Caller tool ${tool.function.name}: ${tool.function.description || ""}`,
      parameters: tool.function.parameters || { type: "object", properties: {} },
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
    }));
    const native = this.nativeTools && Array.isArray(body.tools) ? body.tools.filter(tool => !(tool && typeof tool === "object" && typeof tool.name === "string" && /^caller_tool_\d+$/.test(tool.name))) : [];
    const tools = [...native, ...externalTools];
    const compaction = isCompactionRequest(body);
    const choice = compaction ? "auto" : this.choice;
    const toolChoice = typeof choice === "object"
      ? { type: "function", name: `caller_tool_${this.tools.findIndex(t => t.function.name === choice.function.name)}` }
      : choice || "auto";
    // Suppress deferred/native tool definitions and any Codex tool-search additions.
    const input = Array.isArray(body.input) ? body.input.filter(item => {
      const type = item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined;
      return this.nativeTools || (type !== "additional_tools" && type !== "tool_search_output");
    }) : body.input;
    const scopedInput = Array.isArray(input) ? [...input] : [];
    const jsonInstruction = !compaction && this.jsonObject
      ? "\nFor your final answer, Return ONLY a valid JSON object. Do not include markdown, prose, code fences, or any text outside the JSON object. Tool calls may precede the final answer."
      : "";
    const boundary = { type: "message", role: "developer", content: [{ type: "input_text", text: (this.nativeTools ? "External function tools run on the client. Native Codex tools run in the proxy. Do not confuse their paths or permissions." : CALLER_PERMISSION_INSTRUCTIONS) + jsonInstruction }] };
    // CompactionTrigger must remain last; app-server removes it from history
    // after receiving the opaque compaction item.
    scopedInput.splice(compaction ? scopedInput.length - 1 : scopedInput.length, 0, boundary);
    if (this.clientInstructions && !compaction) scopedInput.push({ type: "message", role: "developer", content: [{ type: "input_text", text: this.clientInstructions }] });
    return { ...body, input: scopedInput, tools: choice === "none" ? native : tools, tool_choice: choice === "none" && this.nativeTools ? "auto" : toolChoice, parallel_tool_calls: this.parallel };
  }

  validateResponse(sse: string, compaction = false): ModelToolCall[] {
    const calls = new Map<string, ModelToolCall>();
    const output = new Map<string, Record<string, unknown>>();
    if (this.responses) this.validators ||= compileToolSchemas(this.tools);
    let completed = false;
    let compactItems = 0;
    const inspect = (item: Record<string, unknown>, partial = false) => {
      if (compaction) {
        if (item.type !== "compaction") throw new CallerInferenceError("caller_invalid_compaction", "Caller compaction returned a non-compaction item");
        if (!partial && (typeof item.encrypted_content !== "string" || !item.encrypted_content)) throw new CallerInferenceError("caller_invalid_compaction", "Caller compaction omitted encrypted content");
        return;
      }
      if (item.type === "message" || item.type === "reasoning") return;
      if (this.nativeTools && !(item.type === "function_call" && typeof item.name === "string" && item.name.startsWith("caller_tool_"))) return;
      if (item.type !== "function_call") throw new CallerInferenceError("caller_forbidden_tool_item", "Caller inference returned a forbidden tool item");
      const index = this.tools.findIndex((_, i) => item.name === `caller_tool_${i}`);
      if (index < 0 || this.choice === "none") throw new CallerInferenceError("caller_unknown_tool", "Caller inference returned a non-allowlisted tool");
      if (typeof this.choice === "object" && this.tools[index].function.name !== this.choice.function.name) {
        throw new CallerInferenceError("caller_tool_choice_violation", "Caller inference violated named tool_choice");
      }
      if (partial) return;
      if (typeof item.arguments !== "string" || typeof item.call_id !== "string" || !item.call_id) throw new CallerInferenceError("caller_incomplete_function_call", "Caller inference returned an incomplete function call");
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { throw new CallerInferenceError("caller_invalid_arguments", "Caller inference returned invalid JSON arguments"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new CallerInferenceError("caller_invalid_arguments", "Caller arguments must be a JSON object");
      const validator = this.validators?.get(this.tools[index].function.name);
      if (validator && !validator(args)) throw new CallerInferenceError("caller_invalid_arguments", "Caller arguments do not match the function JSON Schema");
      const previous = calls.get(item.call_id);
      if (previous && (previous.name !== this.tools[index].function.name || previous.arguments !== item.arguments)) throw new CallerInferenceError("caller_inconsistent_function_call", "Caller inference changed a completed call");
      calls.set(item.call_id, { callId: item.call_id, name: this.tools[index].function.name, arguments: item.arguments });
    };
    // Buffer a complete inference before releasing it to the harness. This also
    // protects against late/changed tool names and exposes the entire parallel batch.
    for (const block of sse.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data); } catch { throw new CallerInferenceError("caller_invalid_upstream_sse", "Invalid upstream SSE JSON"); }
      if (event.type === "response.output_item.done" && event.item) {
        inspect(event.item as Record<string, unknown>);
        const item = event.item as Record<string, unknown>;
        if (typeof item.id === "string") output.set(item.id, item);
        if (compaction) compactItems++;
      }
      if (event.type === "response.output_item.added" && event.item) {
        const item = event.item as Record<string, unknown>;
        if (compaction || (item.type !== "message" && item.type !== "reasoning")) {
          // Arguments are incomplete at added; still validate type and name now.
          inspect(item, true);
        }
      }
      if (event.type === "response.completed") {
        completed = true;
        const finalOutput = (event.response as Record<string, unknown>)?.output;
        if (Array.isArray(finalOutput) && finalOutput.length) {
          output.clear();
          for (const item of finalOutput) { inspect(item); if (typeof item.id === "string") output.set(item.id, item); }
        }
      }
      if (event.type === "response.failed" || event.type === "error") throw new CallerInferenceError("caller_upstream_response_failed", "Upstream caller inference failed");
    }
    if (!completed) throw new CallerInferenceError("caller_incomplete_upstream_stream", "Incomplete caller inference stream");
    if (compaction && compactItems !== 1) throw new CallerInferenceError("caller_invalid_compaction", "Caller compaction must return exactly one compaction item");
    if (!compaction && (this.choice === "required" || typeof this.choice === "object") && calls.size === 0) {
      throw new CallerInferenceError("caller_tool_choice_violation", "Caller inference did not satisfy tool_choice");
    }
    if (!compaction && !this.parallel && calls.size > 1) throw new CallerInferenceError("caller_parallel_tool_calls_violation", "Backend returned multiple calls with parallel_tool_calls false");
    this.output = [...output.values()];
    return [...calls.values()];
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const controller = new AbortController();
      this.controllers.add(controller);
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      try {
        if (req.method !== "POST" || req.url !== "/responses") { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new CallerInferenceError("caller_request_too_large", "Caller inference request too large");
          chunks.push(chunk);
        }
        const original = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const compaction = isCompactionRequest(original);
        const body = this.rewriteRequest(original);
        const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
        // Keep app-server auth/routing/protocol headers, while fetch owns the
        // hop-by-hop transport headers and recalculates the rewritten body size.
        const excluded = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "content-encoding", "content-type", "accept"]);
        for (const [key, value] of Object.entries(req.headers)) {
          if (!excluded.has(key) && typeof value === "string") headers.set(key, value);
        }
        const upstream = await fetch(this.upstream, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
        if (!upstream.ok) throw new CallerInferenceError("caller_upstream_http_error", `Caller inference upstream returned HTTP ${upstream.status}`, upstream.status);
        if (!upstream.body) throw new CallerInferenceError("caller_empty_upstream_response", "Caller upstream has no body");
        const parts: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) throw new CallerInferenceError("caller_response_too_large", "Caller inference response too large");
          parts.push(chunk);
        }
        const sse = Buffer.concat(parts).toString("utf8");
        const calls = this.validateResponse(sse, compaction);
        this.lastFailure = undefined;
        if (calls.length) this.onCalls(calls);
        res.writeHead(200, { "content-type": "text/event-stream" }).end(sse);
      } catch (err) {
        const error = err instanceof CallerInferenceError ? err : new CallerInferenceError("caller_upstream_transport_error", "Caller inference transport failed");
        // Static codes and numeric status only; no prompts, arguments, URLs,
        // credentials, model output, or upstream error body are logged.
        this.lastFailure = error;
        const retryable = error.code === "caller_upstream_transport_error"
          || error.code === "caller_incomplete_upstream_stream"
          || (error.code === "caller_upstream_http_error" && [408, 425, 429, 500, 502, 503, 504].includes(error.upstreamStatus || 0));
        console.error(JSON.stringify({ event: "caller.inference_failed", mode: "caller", code: error.code, upstreamStatus: error.upstreamStatus, retryable }));
        // The harness owns inference retries. Keep its pending RPC/turn alive
        // for transient upstream failures; never replay a client operation.
        if (!retryable) this.onFailure(error);
        if (!res.headersSent) res.writeHead(retryable ? error.upstreamStatus || 502 : 502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message, code: error.code, type: "server_error" } }));
        else res.destroy();
      } finally { this.controllers.delete(controller); }
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { server.off("listening", ready); server.off("error", failed); server.off("close", closed); };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error("Caller listener closed during startup"));
      server.once("listening", ready); server.once("error", failed); server.once("close", closed);
      server.listen(0, "127.0.0.1");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Caller inference listener failed");
    return `http://127.0.0.1:${address.port}`;
  }

  close(): void {
    for (const controller of this.controllers) controller.abort();
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
