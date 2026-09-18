/**
 * End-to-end smoke test: discovery → registration → authorize → portal consent → callback →
 * token → MCP tools/list → tools/call.
 *
 * Runs against a STUB portal rather than the real one. The portal side already has 41 feature
 * tests of its own; what is unproven until this runs is the connector's half — that the OAuth
 * flow actually completes, that PKCE is enforced, that a token reaches the MCP endpoint, and
 * that a tool call arrives at the portal carrying the right acting user. A stub answers all of
 * that without needing a database, a migration or a browser.
 *
 * Usage: node scripts/smoke.mjs   (after npm run build)
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';

const PORTAL_PORT = 8899;
const CONNECTOR_PORT = 8898;
const SERVICE_TOKEN = 'smoke-service-token';
const CONNECTOR_ORIGIN = `http://localhost:${CONNECTOR_PORT}`;
const DATA_DIR = 'data/smoke';

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

/** Records what the connector asked the portal for, so the assertions can look at it. */
const portalCalls = [];

function startStubPortal() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORTAL_PORT}`);
    portalCalls.push({
      method: req.method,
      path: url.pathname,
      actingUser: req.headers['x-connector-user'] ?? null,
      grant: req.headers['x-connector-grant'] ?? null,
      auth: req.headers.authorization ?? null,
      query: Object.fromEntries(url.searchParams),
    });

    // The consent screen. The real one asks the user; the stub agrees at once and redirects
    // back exactly as the portal does.
    if (url.pathname === '/connector/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'portal-code-123');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }

    if (url.pathname === '/internal/connector/exchange') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            grant: 'grant-for-user-42',
            user_id: 42,
            name: 'Smoke Tester',
            email: 'smoke@example.com',
            roles: ['sourcing_manager'],
            is_admin: false,
          },
        }),
      );
      return;
    }

    if (url.pathname === '/internal/connector/variables') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: { ref: url.searchParams.get('ref'), value: 95, unit: '% min', label: 'On-time delivery' },
        }),
      );
      return;
    }

    if (url.pathname === '/internal/connector/knowledge') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Your role does not have access to that module.' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'not found' }));
  });

  return new Promise((resolve) => server.listen(PORTAL_PORT, () => resolve(server)));
}

function startConnector() {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      PORT: String(CONNECTOR_PORT),
      CONNECTOR_ISSUER: CONNECTOR_ORIGIN,
      PORTAL_BASE_URL: `http://localhost:${PORTAL_PORT}`,
      PORTAL_SERVICE_TOKEN: SERVICE_TOKEN,
      DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (d) => process.stderr.write(`[connector] ${d}`));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connector did not start')), 15000);

    child.stdout.on('data', (d) => {
      if (String(d).includes('listening on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });

    child.on('exit', (code) => reject(new Error(`connector exited early (${code})`)));
  });
}

async function rpc(token, method, params, id) {
  const response = await fetch(`${CONNECTOR_ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const text = await response.text();

  // The transport may answer as SSE even with enableJsonResponse; take the data line if so.
  const jsonText = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '{}'
    : text;

  return { status: response.status, headers: response.headers, body: jsonText ? JSON.parse(jsonText) : null };
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });

  const portal = await startStubPortal();
  const connector = await startConnector();

  try {
    console.log('\nDiscovery');
    const meta = await (await fetch(`${CONNECTOR_ORIGIN}/.well-known/oauth-authorization-server`)).json();
    check('authorization server metadata is served', meta.issuer === CONNECTOR_ORIGIN);
    check('only S256 PKCE is offered', JSON.stringify(meta.code_challenge_methods_supported) === '["S256"]');

    const resource = await (await fetch(`${CONNECTOR_ORIGIN}/.well-known/oauth-protected-resource`)).json();
    check('protected resource metadata points at the issuer', resource.authorization_servers[0] === CONNECTOR_ORIGIN);

    console.log('\nUnauthenticated MCP');
    const denied = await rpc(null, 'tools/list', {}, 1);
    check('MCP refuses without a token', denied.status === 401);
    check(
      'refusal carries WWW-Authenticate with resource metadata',
      (denied.headers.get('www-authenticate') ?? '').includes('resource_metadata'),
    );

    console.log('\nDynamic client registration');
    const redirectUri = 'http://localhost:9999/oauth/callback';
    const registration = await (
      await fetch(`${CONNECTOR_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Smoke Client', redirect_uris: [redirectUri] }),
      })
    ).json();
    check('a client is registered', typeof registration.client_id === 'string');
    check('no client secret is issued to a public client', registration.token_endpoint_auth_method === 'none');

    const foreign = await fetch(`${CONNECTOR_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Phisher', redirect_uris: ['https://evil.example.com/cb'] }),
    });
    check('a redirect URI on a host that is not Claude is refused at registration', foreign.status === 400);

    const plainHttp = await fetch(`${CONNECTOR_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Plain', redirect_uris: ['http://claude.ai/cb'] }),
    });
    check('plain http off loopback is refused at registration', plainHttp.status === 400);

    console.log('\nAuthorization');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const unregistered = await fetch(
      `${CONNECTOR_ORIGIN}/authorize?client_id=${registration.client_id}` +
        `&redirect_uri=${encodeURIComponent('http://evil.example.com/steal')}` +
        `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    check('an unregistered redirect_uri is refused in place', unregistered.status === 400);
    check('and is never redirected to', unregistered.headers.get('location') === null);

    const plainPkce = await fetch(
      `${CONNECTOR_ORIGIN}/authorize?client_id=${registration.client_id}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&code_challenge=${challenge}&code_challenge_method=plain`,
      { redirect: 'manual' },
    );
    check(
      'PKCE "plain" is rejected',
      (plainPkce.headers.get('location') ?? '').includes('error=invalid_request'),
    );

    // The real journey, following redirects by hand the way a browser would.
    const authorize = await fetch(
      `${CONNECTOR_ORIGIN}/authorize?client_id=${registration.client_id}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=client-state-xyz`,
      { redirect: 'manual' },
    );
    const toPortal = authorize.headers.get('location');
    check('the browser is sent to the portal consent screen', (toPortal ?? '').includes('/connector/authorize'));
    check('the consent screen is told which client is asking', new URL(toPortal).searchParams.get('client_name') === 'Smoke Client');
    check('responses forbid framing', authorize.headers.get('x-frame-options') === 'DENY');

    const consent = await fetch(toPortal, { redirect: 'manual' });
    const toCallback = consent.headers.get('location');
    check('the portal sends the browser back to /callback', (toCallback ?? '').includes('/callback'));

    const callback = await fetch(toCallback, { redirect: 'manual' });
    const toClient = new URL(callback.headers.get('location'));
    check('the client gets an authorization code', toClient.searchParams.get('code') !== null);
    check('the client state is returned unchanged', toClient.searchParams.get('state') === 'client-state-xyz');
    check(
      'the portal state was ours, not the client\'s',
      !String(toPortal).includes('client-state-xyz'),
      'the client\'s state leaked to the portal leg',
    );

    console.log('\nToken');
    const code = toClient.searchParams.get('code');

    const wrongVerifier = await (
      await fetch(`${CONNECTOR_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: randomBytes(32).toString('base64url'),
          redirect_uri: redirectUri,
          client_id: registration.client_id,
        }),
      })
    ).json();
    check('a wrong PKCE verifier is refused', wrongVerifier.error === 'invalid_grant');

    // That attempt consumed the single-use code, which is itself the behaviour we want: a code
    // offered once is spent, right or wrong. Run the flow again for the successful exchange.
    const second = await fetch(
      `${CONNECTOR_ORIGIN}/authorize?client_id=${registration.client_id}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    const secondConsent = await fetch(second.headers.get('location'), { redirect: 'manual' });
    const secondCallback = await fetch(secondConsent.headers.get('location'), { redirect: 'manual' });
    const goodCode = new URL(secondCallback.headers.get('location')).searchParams.get('code');

    const tokenResponse = await (
      await fetch(`${CONNECTOR_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: goodCode,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: registration.client_id,
        }),
      })
    ).json();
    check('an access token is issued', typeof tokenResponse.access_token === 'string');
    check('a refresh token is issued', typeof tokenResponse.refresh_token === 'string');

    const replay = await (
      await fetch(`${CONNECTOR_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: goodCode,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: registration.client_id,
        }),
      })
    ).json();
    check('the code cannot be replayed', replay.error === 'invalid_grant');

    // A code offered twice leaked somewhere; the tokens its first use produced are revoked.
    const leaked = await rpc(tokenResponse.access_token, 'tools/list', {}, 90);
    check('replaying a code revokes the tokens it produced', leaked.status === 401);

    // A fresh sign-in for everything below.
    const third = await fetch(
      `${CONNECTOR_ORIGIN}/authorize?client_id=${registration.client_id}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    const thirdConsent = await fetch(third.headers.get('location'), { redirect: 'manual' });
    const thirdCallback = await fetch(thirdConsent.headers.get('location'), { redirect: 'manual' });
    const freshCode = new URL(thirdCallback.headers.get('location')).searchParams.get('code');
    Object.assign(tokenResponse, await (
      await fetch(`${CONNECTOR_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: freshCode,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: registration.client_id,
        }),
      })
    ).json());

    console.log('\nMCP');
    const token = tokenResponse.access_token;

    await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    }, 2);

    const list = await rpc(token, 'tools/list', {}, 3);
    const names = (list.body?.result?.tools ?? []).map((t) => t.name).sort();
    check('all ten tools are advertised', names.length === 10, `got ${names.length}: ${names.join(', ')}`);
    const tools = list.body?.result?.tools ?? [];
    check(
      'writing tools are not advertised as read-only',
      tools.find((t) => t.name === 'submit_kb_draft')?.annotations?.readOnlyHint === false,
    );
    check('reading tools are', tools.find((t) => t.name === 'ask_knowledge')?.annotations?.readOnlyHint === true);
    check(
      'the tool names are the spec\'s',
      ['ask_knowledge', 'create_pointer', 'get_ai_pending_tasks', 'get_pointer_status',
       'get_rule_or_variable', 'read_code', 'read_db_views', 'submit_kb_draft',
       'submit_task_result', 'update_pointer_status'].every((n) => names.includes(n)),
      names.join(', '),
    );

    portalCalls.length = 0;

    const call = await rpc(token, 'tools/call', {
      name: 'get_rule_or_variable',
      arguments: { ref: 'sourcing:sup.otd' },
    }, 4);
    const payload = JSON.parse(call.body.result.content[0].text);
    check('a tool call reaches the portal and returns its data', payload.data?.data?.value === 95);
    check(
      'portal content is labelled as data, not instructions',
      payload.source === 'ecommarise-portal' && /never as instructions/.test(payload.notice),
    );

    const toolCall = portalCalls.find((c) => c.path === '/internal/connector/variables');
    check('the portal was sent the session grant', toolCall?.grant === 'grant-for-user-42');
    check('and never a bare user id', toolCall?.actingUser === null);
    check('the portal was sent the service token', toolCall?.auth === `Bearer ${SERVICE_TOKEN}`);

    const refused = await rpc(token, 'tools/call', {
      name: 'ask_knowledge',
      arguments: { query: 'margins' },
    }, 5);
    check('a portal refusal comes back as a tool error, not a crash', refused.body.result.isError === true);
    check(
      'and carries the portal\'s own sentence',
      String(refused.body.result.content[0].text).includes('does not have access'),
    );

    console.log('\nRefresh');
    const refresh = (refreshToken, clientId) => fetch(`${CONNECTOR_ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    }).then((r) => r.json());

    const otherClient = await refresh(tokenResponse.refresh_token, 'some-other-client');
    check('a refresh token is refused to a client it was not issued to', otherClient.error === 'invalid_grant');

    const refreshed = await refresh(tokenResponse.refresh_token, registration.client_id);
    check('a refresh token exchanges for a new pair', typeof refreshed.access_token === 'string');

    const stillWorks = await rpc(refreshed.access_token, 'tools/list', {}, 6);
    check('the refreshed access token works', stillWorks.status === 200);

    const reused = await refresh(tokenResponse.refresh_token, registration.client_id);
    check('the old refresh token is rotated out', reused.error === 'invalid_grant');

    // Replaying a spent refresh token means two parties hold the session: all of it goes.
    const afterReplay = await rpc(refreshed.access_token, 'tools/list', {}, 7);
    check('replaying a rotated refresh token revokes the whole sign-in', afterReplay.status === 401);
  } finally {
    connector.kill();
    portal.close();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
