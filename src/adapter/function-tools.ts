import { Ajv, type ValidateFunction } from "ajv";
import type { ChatCompletionTool } from "../types/openai.js";
import { CallerRequestError } from "../caller/errors.js";

// Compilers are per catalog, never a global unbounded cache of client schemas.
export function compileToolSchemas(tools: ChatCompletionTool[]): Map<string, ValidateFunction> {
  const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, validateFormats: true, addUsedSchema: false });
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (Buffer.byteLength(JSON.stringify(tool.function.parameters || {})) > 256 * 1024) throw new CallerRequestError("Function schema exceeds 256 KiB", 413, "invalid_tool_schema");
    const schema = tool.function.parameters || { type: "object", properties: {} };
    try { validators.set(tool.function.name, ajv.compile(schema)); }
    catch { throw new CallerRequestError("Invalid or unsupported function JSON Schema", 400, "invalid_tool_schema"); }
  }
  return validators;
}
