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
import { registerSetupRoutes } from './enroll.js';
import { authenticate, handleMcpRequest, unauthorized } from './mcp/server.js';
import { portalCallbackUrl, registerOAuthRoutes } from './oauth/routes.js';
import { TokenStore } from './oauth/store.js';
import { PortalClient } from './portal.js';
import { RevocationSweeper } from './revocations.js';
import { ServiceTokenStore } from './serviceToken.js';

const config = loadConfig();
const store = TokenStore.open(config.dataDir);
const serviceTokens = ServiceTokenStore.open(config.dataDir, config.portalServiceTokenFromEnv);
// Read per call rather than captured: enrolling replaces the token while the process runs.
const portal = new PortalClient(
  config,
  () => serviceTokens.current(),
  // The portal has just refused this user because an administrator ended their sessions.
  // Drop what we hold for them now rather than waiting for the sweep — the refusal arrived
  // while they were using it, so this is the earliest anyone could know.
  (userId) => {
    const removed = store.revokeSessionsStartedBefore(userId, Date.now());

    if (removed > 0) {
      console.log(`[revocations] portal ended user ${userId}'s sessions; dropped ${removed} token(s)`);
    }
  },
);

const sweeper = new RevocationSweeper(portal, store, config.revocationPollSeconds * 1000);

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

registerSetupRoutes(app, config, serviceTokens);
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
    await handleMcpRequest(req, res, {
      // Stamped with this session's start, so every call the tools make carries it and the
      // portal can tell a session that predates a revocation from one that does not.
      portal: portal.forSession(identity.sessionStarted),
      userId: identity.userId,
      userName: identity.userName,
    });
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
  // `token` says where the credential came from, never what it is. A monitor that can see
  // "enrolled" versus "none" can tell a connector nobody finished setting up from one that is
  // merely idle, which is the difference worth paging somebody about.
  res.json({ ok: true, issuer: config.issuer, token: serviceTokens.source() });
});

app.listen(config.port, () => {
  console.log(`Ecommarise Connector listening on :${config.port}`);
  console.log(`  issuer          ${config.issuer}`);
  console.log(`  portal          ${config.portalBaseUrl}`);
  console.log(`  MCP endpoint    ${config.issuer}/mcp`);
  console.log('');
  console.log('  Register this callback in the portal CONNECTOR_REDIRECT_URIS:');
  console.log(`    ${portalCallbackUrl(config)}`);
  console.log('');

  switch (serviceTokens.source()) {
    case 'enrolled':
      console.log('  Service token   enrolled — managed by this connector');
      break;
    case 'env':
      console.log('  Service token   from PORTAL_SERVICE_TOKEN in the environment');
      console.log(`                  enrolling at ${config.issuer}/setup replaces it and ends the manual copying`);
      break;
    default:
      // Loud, because the connector is running and answering health checks while being unable
      // to do the one thing it exists for. A line in a log beats a user discovering it.
      console.log('  Service token   NOT SET — this connector cannot reach the portal yet');
      console.log(`                  enrol it at ${config.issuer}/setup`);
  }

  // Started after the listener, not before: the first poll needs a service token, and a
  // connector nobody has enrolled yet has none. It logs one failed poll and carries on, which
  // is the right amount of noise — the setup page is right there in the banner above.
  sweeper.start();
});
