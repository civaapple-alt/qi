import { createInterface } from "node:readline";

const toolsOnly = process.argv.includes("--tools-only");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result = responseFor(message.method, message.params);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});

function responseFor(method, params) {
  if (method === "initialize") return {
    protocolVersion: params?.protocolVersion ?? "2025-11-25",
    capabilities: toolsOnly ? { tools: {} } : { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: "qi-test-stdio", version: "1.0.0" },
    instructions: "Untrusted fixture instructions",
  };
  if (method === "tools/list") return { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false } }] };
  if (method === "resources/list") return { resources: [{ uri: "test://fixture", name: "fixture", mimeType: "text/plain" }] };
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  if (method === "prompts/list") return { prompts: [{ name: "hello", description: "Hello" }] };
  if (method === "tools/call") return { content: [{ type: "text", text: String(params?.arguments?.text ?? "") }], structuredContent: { echoed: String(params?.arguments?.text ?? "") }, isError: false };
  if (method === "resources/read") return { contents: [{ uri: params?.uri, mimeType: "text/plain", text: "fixture resource" }] };
  if (method === "prompts/get") return { messages: [{ role: "user", content: { type: "text", text: "hello" } }] };
  return {};
}
