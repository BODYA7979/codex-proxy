import type { ResponseInputItem, ResponseRequest, ResponseOutputItem, ChatCompletionTool } from "../types/openai.js";
import { CallerRequestError } from "../caller/runtime.js";

interface Entry {
  owner: string;
  history: ResponseInputItem[];
  model: string;
  tools: ChatCompletionTool[];
  execution: Pick<ResponseRequest, "reasoning" | "text" | "response_format"> & { mode?: string };
  pending: string[];
  used: boolean;
  busy: boolean;
  expires: number;
  bytes: number;
}
export interface PreparedResponse {
  input: ResponseInputItem[];
  model: string;
  tools: ChatCompletionTool[];
  pending?: Entry;
  execution: Entry["execution"];
  commit: (id: string, output: ResponseOutputItem[]) => void;
  release: () => void;
}

/** Bounded volatile history; identifiers are capabilities scoped to request owner.
 * Pending worker lifetime is independently bounded by CallerRuntime's TTL. */
export class ResponseState {
  private readonly entries = new Map<string, Entry>();
  private readonly calls = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly limits: () => { ttl: number; entries: number; bytes: number; historyBytes: number }, private readonly now = Date.now) {}
  private remove(id: string, entry: Entry): void {
    this.entries.delete(id); this.bytes -= entry.bytes;
    for (const call of entry.pending) if (this.calls.get(call) === entry) this.calls.delete(call);
  }
  sweep(): void { for (const [id, entry] of this.entries) if (entry.expires <= this.now() && !entry.busy) this.remove(id, entry); }
  clear(): void { this.entries.clear(); this.calls.clear(); this.bytes = 0; }

  prepare(owner: string, body: ResponseRequest, incoming: ResponseInputItem[], model: string, suppliedTools: ChatCompletionTool[], mode?: string): PreparedResponse {
    this.sweep();
    const previous = body.previous_response_id ? this.entries.get(body.previous_response_id) : undefined;
    if (body.previous_response_id && (!previous || previous.owner !== owner)) throw new CallerRequestError("Unknown, expired or foreign previous_response_id", 400, "previous_response_not_found");
    const input = previous ? [...previous.history, ...incoming] : [...incoming];
    const pendingCalls = new Map<string, ResponseInputItem>();
    const answered = new Set<string>();
    // Resolve and validate actual call/output pairs rather than treating outputs
    // as anonymous user messages. Completed replay pairs may use old catalogs.
    for (const item of input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new CallerRequestError("Invalid input item");
      if (item.type === "function_call") {
        const call = item as { call_id?: string };
        if (!call.call_id || pendingCalls.has(call.call_id) || answered.has(call.call_id)) throw new CallerRequestError("Duplicate or invalid call_id");
        pendingCalls.set(call.call_id, item);
      } else if (item.type === "function_call_output") {
        const result = item as { call_id: string };
        if (!pendingCalls.has(result.call_id)) throw new CallerRequestError("Unknown or duplicate call_id", 400, "invalid_call_id");
        pendingCalls.delete(result.call_id); answered.add(result.call_id);
      }
    }
    if (pendingCalls.size) throw new CallerRequestError("Return exactly one output for every function call", 400, "missing_tool_output");
    const outputs = incoming.filter(item => item.type === "function_call_output") as Array<{ call_id: string }>;
    const pending = previous?.pending.length ? previous : (incoming.at(-1)?.type === "function_call_output" ? [...outputs].reverse().map(item => this.calls.get(item.call_id)).find(Boolean) : undefined);
    if (pending) {
      if (pending.owner !== owner) throw new CallerRequestError("Unknown, expired or foreign call_id", 400, "invalid_call_id");
      if (pending.used) throw new CallerRequestError("Tool outputs already submitted", 409, "duplicate_tool_output");
      if (pending.busy) throw new CallerRequestError("Response continuation already active", 409, "continuation_active");
      const ids = outputs.map(item => item.call_id).filter(id => pending.pending.includes(id));
      if (ids.length !== pending.pending.length || new Set(ids).size !== ids.length) throw new CallerRequestError("Return exactly one output for every pending call_id", 400, "missing_tool_output");
      const tail = incoming.slice(-ids.length);
      if (!tail.every(item => item.type === "function_call_output" && pending.pending.includes((item as { call_id: string }).call_id))) throw new CallerRequestError("Live continuation must end with the pending tool outputs; send new messages after completion");
      for (const id of ids) {
        const expected = pending.history.find(item => item.type === "function_call" && (item as { call_id: string }).call_id === id);
        const actual = input.find(item => item.type === "function_call" && (item as { call_id: string }).call_id === id);
        const fields = (item: ResponseInputItem | undefined) => { const call = item as { name: string; arguments: string }; return [call?.name, call?.arguments]; };
        if (JSON.stringify(fields(expected)) !== JSON.stringify(fields(actual))) throw new CallerRequestError("Replayed function call differs from issued call");
      }
    }
    const resolvedModel = body.model ? model : previous?.model || pending?.model || model;
    const tools = body.tools === undefined ? previous?.tools || pending?.tools || suppliedTools : suppliedTools;
    const execution = {
      mode: mode || pending?.execution.mode,
      reasoning: body.reasoning === undefined ? pending?.execution.reasoning : body.reasoning,
      text: body.text === undefined ? pending?.execution.text : body.text,
      response_format: body.response_format === undefined ? pending?.execution.response_format : body.response_format,
    };
    if (pending && JSON.stringify(execution) !== JSON.stringify(pending.execution)) throw new CallerRequestError("A pending turn must preserve execution mode, reasoning and text format");
    // Omitted catalog/model is inherited; other execution options on a live turn
    // cannot reconfigure an already running harness.
    if (pending && (pending.model !== resolvedModel || JSON.stringify(pending.tools) !== JSON.stringify(tools))) throw new CallerRequestError("Continuation must preserve model and tool definitions");
    const limit = this.limits();
    if (Buffer.byteLength(JSON.stringify(input)) > limit.historyBytes) throw new CallerRequestError("Response history limit exceeded", 413, "response_history_too_large");
    if (pending) pending.busy = true;
    let committed = false;
    return {
      input, model: resolvedModel, tools, pending, execution,
      release: () => { if (pending) pending.busy = false; },
      commit: (id, output) => {
        if (committed) throw new Error("Response already committed");
        const history = [...input, ...output] as ResponseInputItem[];
        const historyBytes = Buffer.byteLength(JSON.stringify(history));
        const bytes = historyBytes + Buffer.byteLength(JSON.stringify([tools, execution]));
        if (historyBytes > limit.historyBytes || bytes > limit.bytes) throw new CallerRequestError("Response history limit exceeded", 413, "response_history_too_large");
        if (body.store !== false) {
          while (this.entries.size >= limit.entries || this.bytes + bytes > limit.bytes) {
            const victim = [...this.entries].find(([, entry]) => !entry.busy && (!entry.pending.length || entry.used));
            if (!victim) throw new CallerRequestError("Response state capacity reached", 429, "response_state_capacity");
            this.remove(...victim);
          }
          const entry: Entry = { owner, history: structuredClone(history), model: resolvedModel, tools: structuredClone(tools), execution: structuredClone(execution),
            pending: output.filter(item => item.type === "function_call").map(item => item.call_id), used: false, busy: false, expires: this.now() + limit.ttl, bytes };
          this.entries.set(id, entry); this.bytes += bytes;
          for (const call of entry.pending) this.calls.set(call, entry);
        }
        if (pending) { pending.used = true; pending.busy = false; }
        committed = true;
      },
    };
  }
}
