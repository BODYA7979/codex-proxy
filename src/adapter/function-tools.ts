import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { ChatCompletionTool } from "../types/openai.js";
import { CallerRequestError } from "../caller/errors.js";

// Compilers are per catalog, never a global unbounded cache of client schemas.
export function compileToolSchemas(tools: ChatCompletionTool[]): Map<string, ValidateFunction> {
  const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, validateFormats: true, addUsedSchema: false });
  addFormats.default(ajv);
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (Buffer.byteLength(JSON.stringify(tool.function.parameters || {})) > 256 * 1024) throw new CallerRequestError("Function schema exceeds 256 KiB", 413, "invalid_tool_schema");
    const schema = tool.function.parameters || { type: "object", properties: {} };
    try { validators.set(tool.function.name, ajv.compile(schema)); }
    catch { throw new CallerRequestError("Invalid or unsupported function JSON Schema", 400, "invalid_tool_schema"); }
  }
  return validators;
}

/** Text content-array results from AI SDK are ordered client results, not
 * assistant input. Preserve each part without discarding unsupported media. */
export function functionOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) throw new CallerRequestError("function_call_output must be a string or content array");
  return output.map(part => {
    if (!part || typeof part !== "object" || !["input_text", "output_text", "text"].includes(part.type) || typeof part.text !== "string") throw new CallerRequestError("Only text function output parts are supported", 400, "unsupported_tool_output");
    return part.text;
  }).join("\n");
}
