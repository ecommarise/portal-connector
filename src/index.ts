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
  () => serviceTokens.current(config.portalBaseUrl),
  // The portal has just refused this session as ended. Drop exactly the tokens presenting that
  // grant — this sign-in, however often refreshed — and nothing else. (It used to drop every
  // token of the user started before "now", which also killed a session they had begun after
  // the revocation.)
  (grant) => {
    const removed = store.revokeByGrant(grant);

    if (removed > 0) {
      console.log(`[revocations] the portal ended a session; dropped ${removed} token(s)`);
    }
  },
);

const sweeper = new RevocationSweeper(portal, store, config.revocationPollSeconds * 1000);

const app = express();

app.disable('x-powered-by');
// Who the caller is, for the rate limits: trusted only from the reverse proxy in front of this
// service (loopback by default). Without it everyone behind the proxy shared one address.
app.set('trust proxy', config.trustProxy);

// Headers for every response. Nothing here is meant to be framed by another site (the setup
// page least of all), sniffed as another content type, or to leak its URL — which can carry a
// code or state — in a Referer.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Tool calls are small. 4 MB let an anonymous caller make the server parse a large body on
// every request to /register or /token before anything was checked.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

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
      // Acting for this session's portal grant — the portal resolves the user, and whether the
      // session is still valid, from its own record of it.
      portal: portal.forSession(identity.grant),
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
