import type { ChatCompletionRequest, ChatCompletionTool, ChatMessage, ResponseRequest, ResponseInputItem, ResponseFunctionTool, ResponseFormat } from "../types/openai.js";
import { CallerRequestError, validateCallerRequest } from "../caller/runtime.js";

export { compileToolSchemas } from "../adapter/function-tools.js";
import { compileToolSchemas, functionOutputText } from "../adapter/function-tools.js";

export function normalizeResponsesTools(body: ResponseRequest): ChatCompletionTool[] {
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new CallerRequestError("tools must be an array");
  if ((body.tools?.length || 0) > 128) throw new CallerRequestError("At most 128 function tools are supported");
  return (body.tools || []).map(tool => {
    if (!tool || tool.type !== "function") throw new CallerRequestError("Only function tools are supported", 400, "unsupported_tool_type");
    // Preserve this fork's previously accepted Chat format as an explicit alias.
    const fn = "function" in tool ? tool.function : tool;
    if (!fn || typeof fn !== "object" || (fn.strict !== undefined && fn.strict !== null && typeof fn.strict !== "boolean")
        || (fn.description !== undefined && typeof fn.description !== "string")) throw new CallerRequestError("Invalid function definition");
    const { name, description, parameters, strict } = fn;
    return { type: "function", function: { name, ...(description === undefined ? {} : { description }), ...(parameters === undefined ? {} : { parameters }), ...(strict == null ? {} : { strict }) } };
  });
}

export function responseTools(tools: ChatCompletionTool[]): ResponseFunctionTool[] {
  return tools.map(tool => ({ type: "function", ...tool.function }));
}

export function normalizeTextFormat(body: ResponseRequest): ResponseFormat | undefined {
  if (body.text !== undefined && (!body.text || typeof body.text !== "object" || Array.isArray(body.text))) throw new CallerRequestError("text must be an object");
  if (body.text && Object.keys(body.text).some(key => key !== "format")) throw new CallerRequestError("Only text.format is supported", 400, "unsupported_parameter");
  const format = body.text?.format;
  if (format && body.response_format) throw new CallerRequestError("Use either text.format or response_format");
  if (format !== undefined && (!format || typeof format !== "object" || Array.isArray(format))) throw new CallerRequestError("text.format must be an object");
  if (!format) {
    const legacy = body.response_format;
    if (legacy !== undefined) {
      if (!legacy || typeof legacy !== "object" || !["text", "json_object", "json_schema"].includes(legacy.type)) throw new CallerRequestError("Unsupported response_format");
      if (legacy.type === "json_schema") {
        if (!legacy.json_schema || !legacy.json_schema.schema || (legacy.json_schema.strict !== undefined && typeof legacy.json_schema.strict !== "boolean")) throw new CallerRequestError("Invalid response_format JSON Schema");
        compileToolSchemas([{ type: "function", function: { name: legacy.json_schema.name || "answer", parameters: legacy.json_schema.schema } }]);
      }
    }
    return legacy;
  }
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  if (format.type !== "json_schema" || !format.schema || typeof format.name !== "string" || !format.name) throw new CallerRequestError("Unsupported text.format");
  if (format.strict !== undefined && typeof format.strict !== "boolean") throw new CallerRequestError("text.format.strict must be a boolean");
  // Validate the schema before starting a worker, including unsupported keywords.
  compileToolSchemas([{ type: "function", function: { name: format.name, parameters: format.schema } }]);
  return { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
}

export function normalizeInput(input: ResponseRequest["input"]): ResponseInputItem[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input) || !input.length) throw new CallerRequestError("input must be a string or a non-empty array");
  return input;
}

export function responsesToChat(body: ResponseRequest, input: ResponseInputItem[], tools = normalizeResponsesTools(body)): ChatCompletionRequest {
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model)) throw new CallerRequestError("model must be a non-empty string");
  for (const key of ["stream", "store", "parallel_tool_calls"] as const) if (body[key] !== undefined && typeof body[key] !== "boolean") throw new CallerRequestError(`${key} must be a boolean`);
  if (body.instructions !== undefined && typeof body.instructions !== "string") throw new CallerRequestError("instructions must be a string");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && (typeof body.previous_response_id !== "string" || !body.previous_response_id)) throw new CallerRequestError("Invalid previous_response_id");
  if (body.reasoning != null && (typeof body.reasoning !== "object" || Array.isArray(body.reasoning))) throw new CallerRequestError("reasoning must be an object");
  if (body.reasoning?.effort != null && typeof body.reasoning.effort !== "string") throw new CallerRequestError("reasoning.effort must be a string");
  if (body.reasoning && Object.entries(body.reasoning).some(([key, value]) => key !== "effort" && value != null)) throw new CallerRequestError("Only reasoning.effort is supported", 400, "unsupported_parameter");
  if (body.user !== undefined && typeof body.user !== "string") throw new CallerRequestError("user must be a string");
  if (body.metadata != null && (typeof body.metadata !== "object" || Array.isArray(body.metadata) || Object.values(body.metadata).some(value => typeof value !== "string"))) throw new CallerRequestError("metadata must be an object of strings");
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new CallerRequestError("Invalid input item");
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || typeof item.arguments !== "string") throw new CallerRequestError("Invalid function_call item");
      let args: unknown; try { args = JSON.parse(item.arguments); } catch { throw new CallerRequestError("Invalid function_call arguments"); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new CallerRequestError("Function arguments must be a JSON object");
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] });
    } else if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !item.call_id) throw new CallerRequestError("function_call_output requires call_id");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: functionOutputText(item.output) });
    } else if (item.type === "reasoning" || item.type === "summary_text") {
      const raw = item as { content?: unknown; summary?: Array<{ text?: string }>; text?: string };
      const text = typeof raw.content === "string" ? raw.content : raw.text || raw.summary?.map(part => part.text || "").join("\n");
      if (text) messages.push({ role: "assistant", content: text });
    } else if (item.type === undefined || item.type === "message") {
      const msg = item as { role?: string; content?: unknown };
      if (!["user", "assistant", "system", "developer"].includes(msg.role || "")) throw new CallerRequestError("Invalid input message role");
      let content: ChatMessage["content"];
      if (typeof msg.content === "string") content = msg.content;
      else if (Array.isArray(msg.content)) content = msg.content.map(part => {
        if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") return { type: "text" as const, text: part.text };
        if (["input_image", "image_url"].includes(part?.type)) {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (typeof url === "string") return { type: "image_url" as const, image_url: { url, detail: part.detail } };
        }
        throw new CallerRequestError("Unsupported input content part", 400, "unsupported_input_type");
      });
      else throw new CallerRequestError("Invalid message content");
      messages.push({ role: msg.role as ChatMessage["role"], content });
    } else throw new CallerRequestError("Unsupported input item type", 400, "unsupported_input_type");
  }
  const choice = body.tool_choice;
  const chat: ChatCompletionRequest = {
    model: body.model, messages, tools, user: body.user,
    tool_choice: typeof choice === "object" && choice && "name" in choice ? { type: "function", function: { name: choice.name } } : choice,
    reasoning_effort: body.reasoning?.effort, response_format: normalizeTextFormat(body),
    parallel_tool_calls: body.parallel_tool_calls,
    temperature: body.temperature, top_p: body.top_p, max_completion_tokens: body.max_output_tokens,
  };
  validateCallerRequest(chat);
  compileToolSchemas(tools);
  return chat;
}
