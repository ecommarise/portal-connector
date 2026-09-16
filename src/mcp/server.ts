/**
 * The MCP endpoint.
 *
 * One server instance per request. MCP's streamable HTTP transport is stateless here by
 * design: every request carries its own bearer token, and therefore its own acting user, so a
 * server held open across requests would have to keep track of whose it currently is. Building
 * a fresh one costs microseconds and removes the entire class of bug where one user's session
 * answers another user's question.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';

import type { Config } from '../config.js';
import type { PortalClient } from '../portal.js';
import type { TokenStore } from '../oauth/store.js';
import { TOOLS, type ToolContext } from './tools.js';

function buildServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'ecommarise-connector', version: '0.1.0' },
    {
      instructions:
        'Read-only access to the Ecommarise Portal on behalf of the signed-in user. Answer only ' +
        'from what these tools return, and cite chunk ids and rule references. You cannot change ' +
        'operational data, confirm your own task results, approve pointers, or activate knowledge ' +
        'versions — those are human actions in the portal, so name the person who must do them ' +
        'rather than attempting them.',
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => tool.handler(args, context),
    );
  }

  return server;
}

/**
 * Handle one MCP request for an already-authenticated user.
 */
export async function handleMcpRequest(
  req: Request,
  res: Response,
  context: ToolContext,
): Promise<void> {
  const server = buildServer(context);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — see the file note
    enableJsonResponse: true,
  });

  // Tear both down when the response ends, however it ends. Without this, an aborted request
  // leaves a server and a transport attached to a socket nobody is reading, and a busy day
  // becomes a slow memory leak.
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/**
 * Resolve the bearer token on a request to the user it belongs to.
 *
 * Returns null rather than throwing so the caller can answer with the WWW-Authenticate header
 * MCP clients need in order to discover where to authenticate.
 */
export function authenticate(
  req: Request,
  store: TokenStore,
): { userId: number; userName: string; sessionStarted: number } | null {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match || !match[1]) return null;

  const token = store.findToken(match[1], 'access');

  if (!token) return null;

  // A token from a store written before sessions existed has no start time. Reported as 0 —
  // the beginning of time — so any revocation at all covers it. Wrong in the safe direction.
  return { userId: token.user_id, userName: token.user_name, sessionStarted: token.session_started ?? 0 };
}

export function unauthorized(res: Response, config: Config): void {
  // RFC 9728: point the client at the protected-resource metadata so it can find the
  // authorization server on its own. Without this header a fresh client has nowhere to start.
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource"`,
  );

  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Authentication required.' },
    id: null,
  });
}

export type { PortalClient };
