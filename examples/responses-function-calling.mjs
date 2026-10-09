// npm install openai (included as a development dependency in this repository)
// CODEX_PROXY_MODEL=<available-model> node examples/responses-function-calling.mjs
import OpenAI from "openai";

const model = process.env.CODEX_PROXY_MODEL;
if (!model) throw new Error("Set CODEX_PROXY_MODEL to a model from /v1/models");
const client = new OpenAI({
  apiKey: process.env.CODEX_PROXY_API_KEY || "local-client",
  baseURL: process.env.CODEX_PROXY_BASE_URL || "http://127.0.0.1:3466/v1",
});
const tools = [{
  type: "function", name: "get_weather", description: "Get current weather on the client", strict: true,
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
}];
let response = await client.responses.create({
  model, input: "What is the weather in Kyiv?", tools,
  // This request extension selects client-only execution without changing the server default.
  tool_execution_mode: "caller",
});
for (let round = 0; round < 8; round++) {
  const calls = response.output.filter(item => item.type === "function_call");
  if (!calls.length) break;
  const input = calls.map(call => {
    if (call.name !== "get_weather") throw new Error(`Unexpected function: ${call.name}`);
    const { city } = JSON.parse(call.arguments);
    // Replace this fixture with the client's actual weather API call.
    const weather = { city, temperature: 12, condition: "cloudy", fixture: true };
    return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(weather) };
  });
  const stream = await client.responses.create({
    model, previous_response_id: response.id, input, stream: true,
    tool_execution_mode: "caller", tools, tool_choice: "auto",
  });
  let completed;
  for await (const event of stream) {
    if (event.type === "response.completed") completed = event.response;
    if (event.type === "response.failed") throw new Error(event.response.error?.message || "Response failed");
  }
  if (!completed) throw new Error("Response stream did not complete");
  response = completed;
  if (round === 7 && response.output.some(item => item.type === "function_call")) throw new Error("Client tool-round limit reached");
}

console.log(response.output_text);
