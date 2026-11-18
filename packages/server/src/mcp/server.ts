import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools, type ToolContext } from "./tools.ts";

export const MCP_SERVER_NAME = "retrospecticus";
export const MCP_SERVER_VERSION = "0.1.1";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerTools(server, ctx);
  return server;
}

/**
 * Stateless: every request gets its own server and transport, so nothing ties
 * a client to this process and the calling token is bound per request. JSON
 * responses rather than SSE let the pair be closed as soon as the reply exists.
 */
export async function handleMcpRequest(request: Request, ctx: ToolContext): Promise<Response> {
  if (request.method !== "POST") {
    // Without sessions there is no stream to resume or session to end.
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
