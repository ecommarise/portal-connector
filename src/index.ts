/**
 * The Ecommarise Connector.
 *
 * A remote MCP server that reads the Ecommarise Portal on behalf of whoever signed in. It is
 * the only component on the public internet: the portal sits on a private network and answers
 * only to this service, which is what lets an out-of-support Laravel 8 application be reached
 * from Anthropic's cloud without being exposed to it.
 *
 * See docs/ECOMMARISE_CONNECTOR_FEASIBILITY.md §9 for why it is shaped this way.
 */

import express from 'express';

import { loadConfig } from './config.js';
import { authenticate, handleMcpRequest, unauthorized } from './mcp/server.js';
import { portalCallbackUrl, registerOAuthRoutes } from './oauth/routes.js';
import { TokenStore } from './oauth/store.js';
import { PortalClient } from './portal.js';

const config = loadConfig();
const store = TokenStore.open(config.dataDir);
const portal = new PortalClient(config);

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

registerOAuthRoutes(app, config, store, portal);

/**
 * The MCP endpoint. Every request authenticates on its own — there is no session to attach to,
 * so a token revoked a second ago stops working on the very next call.
 */
app.post('/mcp', async (req, res) => {
  const identity = authenticate(req, store);

  if (!identity) {
    unauthorized(res, config);
    return;
  }

  try {
    await handleMcpRequest(req, res, { portal, userId: identity.userId, userName: identity.userName });
  } catch (error) {
    console.error('[mcp] request failed', error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error.' },
        id: null,
      });
    }
  }
});

// GET and DELETE on /mcp belong to the session-based transport. This server is stateless, so
// saying that plainly is better than a 404, which reads to a client like a wrong URL.
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This connector is stateless; use POST.' },
    id: null,
  });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, issuer: config.issuer });
});

app.listen(config.port, () => {
  console.log(`Ecommarise Connector listening on :${config.port}`);
  console.log(`  issuer          ${config.issuer}`);
  console.log(`  portal          ${config.portalBaseUrl}`);
  console.log(`  MCP endpoint    ${config.issuer}/mcp`);
  console.log('');
  console.log('  Register this callback in the portal CONNECTOR_REDIRECT_URIS:');
  console.log(`    ${portalCallbackUrl(config)}`);
});
