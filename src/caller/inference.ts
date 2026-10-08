import { createServer, type Server } from "node:http";
import type { ChatCompletionRequest, ChatCompletionTool } from "../types/openai.js";

export interface ModelToolCall { callId: string; name: string; arguments: string }

/** The execution boundary: app-server only receives allowlisted function calls.
 * It cannot see a native/custom/hosted tool call, even from a misbehaving model.
 */
export class CallerInference {
  private server?: Server;
  private readonly controllers = new Set<AbortController>();
  private choice: ChatCompletionRequest["tool_choice"];
  constructor(
    readonly tools: ChatCompletionTool[],
    private readonly upstream: string,
    private readonly onCalls: (calls: ModelToolCall[]) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  setChoice(choice: ChatCompletionRequest["tool_choice"]): void { this.choice = choice; }

  rewriteRequest(body: Record<string, unknown>): Record<string, unknown> {
    const tools = this.tools.map((tool, i) => ({
      type: "function", name: `caller_tool_${i}`, description: `Caller tool ${tool.function.name}: ${tool.function.description || ""}`,
      parameters: tool.function.parameters || { type: "object", properties: {} },
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
    }));
    const choice = this.choice;
    const toolChoice = typeof choice === "object"
      ? { type: "function", name: `caller_tool_${this.tools.findIndex(t => t.function.name === choice.function.name)}` }
      : choice || "auto";
    // Suppress deferred/native tool definitions and any Codex tool-search additions.
    const input = Array.isArray(body.input) ? body.input.filter(item => {
      const type = item && typeof item === "object" ? (item as Record<string, unknown>).type : undefined;
      return type !== "additional_tools" && type !== "tool_search_output";
    }) : body.input;
    return { ...body, input, tools: choice === "none" ? [] : tools, tool_choice: toolChoice };
  }

  validateResponse(sse: string): ModelToolCall[] {
    const calls = new Map<string, ModelToolCall>();
    let completed = false;
    const inspect = (item: Record<string, unknown>, partial = false) => {
      if (item.type === "message" || item.type === "reasoning") return;
      if (item.type !== "function_call") throw new Error("Caller inference returned a forbidden tool item");
      const index = this.tools.findIndex((_, i) => item.name === `caller_tool_${i}`);
      if (index < 0 || this.choice === "none") throw new Error("Caller inference returned a non-allowlisted tool");
      if (typeof this.choice === "object" && this.tools[index].function.name !== this.choice.function.name) {
        throw new Error("Caller inference violated named tool_choice");
      }
      if (partial) return;
      if (typeof item.arguments !== "string" || typeof item.call_id !== "string" || !item.call_id) throw new Error("Caller inference returned an incomplete function call");
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { throw new Error("Caller inference returned invalid JSON arguments"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Caller arguments must be a JSON object");
      const previous = calls.get(item.call_id);
      if (previous && (previous.name !== this.tools[index].function.name || previous.arguments !== item.arguments)) throw new Error("Caller inference changed a completed call");
      calls.set(item.call_id, { callId: item.call_id, name: this.tools[index].function.name, arguments: item.arguments });
    };
    // Buffer a complete inference before releasing it to the harness. This also
    // protects against late/changed tool names and exposes the entire parallel batch.
    for (const block of sse.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data); } catch { throw new Error("Invalid upstream SSE JSON"); }
      if (event.type === "response.output_item.done" && event.item) inspect(event.item as Record<string, unknown>);
      if (event.type === "response.output_item.added" && event.item) {
        const item = event.item as Record<string, unknown>;
        if (item.type !== "message" && item.type !== "reasoning") {
          // Arguments are incomplete at added; still validate type and name now.
          inspect(item, true);
        }
      }
      if (event.type === "response.completed") {
        completed = true;
        const output = (event.response as Record<string, unknown>)?.output;
        if (Array.isArray(output)) for (const item of output) inspect(item);
      }
      if (event.type === "response.failed" || event.type === "error") throw new Error("Upstream caller inference failed");
    }
    if (!completed) throw new Error("Incomplete caller inference stream");
    if ((this.choice === "required" || typeof this.choice === "object") && calls.size === 0) {
      throw new Error("Caller inference did not satisfy tool_choice");
    }
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
          if (size > 32 * 1024 * 1024) throw new Error("Caller inference request too large");
          chunks.push(chunk);
        }
        const body = this.rewriteRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
        // Keep app-server auth/routing/protocol headers, while fetch owns the
        // hop-by-hop transport headers and recalculates the rewritten body size.
        const excluded = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "content-encoding", "content-type", "accept"]);
        for (const [key, value] of Object.entries(req.headers)) {
          if (!excluded.has(key) && typeof value === "string") headers.set(key, value);
        }
        const upstream = await fetch(this.upstream, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
        if (!upstream.ok) throw new Error(`Caller upstream HTTP ${upstream.status}`);
        if (!upstream.body) throw new Error("Caller upstream has no body");
        const parts: Uint8Array[] = [];
        let bytes = 0;
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) throw new Error("Caller inference response too large");
          parts.push(chunk);
        }
        const sse = Buffer.concat(parts).toString("utf8");
        const calls = this.validateResponse(sse);
        if (calls.length) this.onCalls(calls);
        res.writeHead(200, { "content-type": "text/event-stream" }).end(sse);
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Caller inference failed");
        this.onFailure(error);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Caller inference rejected", type: "server_error" } }));
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
