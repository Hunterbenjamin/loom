import { createServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type McpServerOptions } from "./server.js";

/** The host entrypoint passes LOOM_MCP_TOKEN from its per-run MCP config's env. */
export async function serveStdio(
  options: McpServerOptions,
  token: string,
  streams?: { input: Readable; output: Writable },
) {
  const server = createMcpServer(options, token);
  await server.connect(
    new StdioServerTransport(streams?.input, streams?.output),
  );
  return server;
}

/** Stateless Streamable HTTP on a loopback ephemeral port; bearer identity on every request. */
export async function serveHttp(options: McpServerOptions, port = 0) {
  const connections = new Set<ReturnType<typeof createMcpServer>>();
  const http = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
    const server = createMcpServer(options, token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${request.socket.localPort}`],
      allowedOrigins: [`http://127.0.0.1:${request.socket.localPort}`],
    });
    connections.add(server);
    response.on("close", () => {
      connections.delete(server);
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP listener has no address");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    async close() {
      await Promise.all([...connections].map((server) => server.close()));
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
    },
  };
}
