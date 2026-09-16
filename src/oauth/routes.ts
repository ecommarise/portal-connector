/**
 * The OAuth 2.1 authorization server — discovery, dynamic client registration, and the
 * authorization-code flow with PKCE.
 *
 * This service is the authorization server; the portal is the identity source. The split is
 * the whole design (see docs/ECOMMARISE_CONNECTOR_FEASIBILITY.md §9.1): the portal already
 * knows who everyone is and what they may read, and it should not also have to grow a
 * standards-compliant token endpoint inside an out-of-support framework.
 *
 * The flow, end to end:
 *
 *   1. Claude              → GET  /authorize            (client_id, PKCE challenge, state)
 *   2. we redirect the browser → portal /connector/authorize
 *   3. the user consents in the portal
 *   4. portal redirects        → GET /callback          (portal's one-time code)
 *   5. we exchange that code server-to-server for the user's identity
 *   6. we redirect the browser → Claude's redirect_uri   (OUR authorization code)
 *   7. Claude              → POST /token                (code + code_verifier)
 *
 * Two authorization codes exist because two trust boundaries are being crossed. The portal's
 * code proves "this browser was user 42" to us; ours proves "we authenticated somebody for
 * you" to Claude. Reusing one for both would mean handing Claude a credential minted by the
 * portal for us.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';

import type { Config } from '../config.js';
import type { PortalClient } from '../portal.js';
import { hashToken, newSecret, TokenStore } from './store.js';

/** The URI the PORTAL redirects back to. Registered in the portal's CONNECTOR_REDIRECT_URIS. */
export function portalCallbackUrl(config: Config): string {
  return `${config.issuer}/callback`;
}

function verifyPkce(challenge: string, verifier: string): boolean {
  const expected = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);

  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  return a.length === b.length && timingSafeEqual(a, b);
}

function redirectWithError(res: Response, redirectUri: string, error: string, state: string | null): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);

  res.redirect(url.toString());
}

export function registerOAuthRoutes(
  app: Express,
  config: Config,
  store: TokenStore,
  portal: PortalClient,
): void {
  // ------------------------------------------------------------------ discovery

  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      registration_endpoint: `${config.issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // S256 only. OAuth 2.1 removes `plain`, and offering it would let a client downgrade
      // itself out of the protection PKCE exists to give.
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['portal:read'],
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: config.issuer,
      authorization_servers: [config.issuer],
      scopes_supported: ['portal:read'],
    });
  });

  // ------------------------------------------------------------------ dynamic registration

  app.post('/register', (req: Request, res: Response) => {
    const body = req.body as { client_name?: unknown; redirect_uris?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : [];

    if (redirectUris.length === 0) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'At least one redirect_uri is required.',
      });
      return;
    }

    const client = store.registerClient(
      typeof body.client_name === 'string' ? body.client_name : 'Unnamed MCP client',
      redirectUris,
    );

    // A public client: no secret. The client is a desktop or cloud application that cannot
    // keep one, which is exactly the case PKCE was designed for — issuing a secret it must
    // then ship somewhere would be theatre.
    res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // ------------------------------------------------------------------ authorize

  app.get('/authorize', (req: Request, res: Response) => {
    const clientId = String(req.query.client_id ?? '');
    const redirectUri = String(req.query.redirect_uri ?? '');
    const responseType = String(req.query.response_type ?? '');
    const codeChallenge = String(req.query.code_challenge ?? '');
    const method = String(req.query.code_challenge_method ?? '');
    const state = req.query.state === undefined ? null : String(req.query.state);

    const client = store.findClient(clientId);

    // Before anything is redirected anywhere, the redirect target must be one this client
    // registered. An unregistered target is reported HERE, in the browser, never by
    // redirecting to it — redirecting would be the open-redirect the check exists to prevent.
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      res.status(400).send('Unknown client, or a redirect_uri this client did not register.');
      return;
    }

    if (responseType !== 'code') {
      redirectWithError(res, redirectUri, 'unsupported_response_type', state);
      return;
    }

    if (method !== 'S256' || codeChallenge === '') {
      redirectWithError(res, redirectUri, 'invalid_request', state);
      return;
    }

    // Our own state for the portal leg. Not the client's: passing the client's state onward
    // would let whoever chose it recognise the login when it comes back.
    const portalState = newSecret(24);

    store.startPortalLogin({
      state: portalState,
      client_id: clientId,
      client_redirect_uri: redirectUri,
      client_state: state,
      code_challenge: codeChallenge,
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    const portalUrl = new URL(`${config.portalBaseUrl}/connector/authorize`);
    portalUrl.searchParams.set('redirect_uri', portalCallbackUrl(config));
    portalUrl.searchParams.set('state', portalState);

    res.redirect(portalUrl.toString());
  });

  // ------------------------------------------------------------------ portal callback

  app.get('/callback', async (req: Request, res: Response) => {
    const portalCode = String(req.query.code ?? '');
    const portalState = String(req.query.state ?? '');

    const login = store.takePortalLogin(portalState);

    if (!login) {
      res.status(400).send('This sign-in link has expired or was already used. Please start again.');
      return;
    }

    if (portalCode === '') {
      redirectWithError(res, login.client_redirect_uri, 'access_denied', login.client_state);
      return;
    }

    let identity;

    try {
      identity = await portal.exchange(portalCode, portalCallbackUrl(config));
    } catch {
      // Deliberately not surfacing the portal's message to the browser. It distinguishes
      // "expired code" from "deactivated account", and that difference is not something an
      // unauthenticated visitor should be able to probe for.
      redirectWithError(res, login.client_redirect_uri, 'access_denied', login.client_state);
      return;
    }

    const code = newSecret(32);

    store.issueAuthorization({
      code_hash: hashToken(code),
      client_id: login.client_id,
      redirect_uri: login.client_redirect_uri,
      code_challenge: login.code_challenge,
      user_id: identity.user_id,
      user_name: identity.name,
      expires_at: Date.now() + config.authCodeTtl * 1000,
      used: false,
    });

    const back = new URL(login.client_redirect_uri);
    back.searchParams.set('code', code);
    if (login.client_state) back.searchParams.set('state', login.client_state);

    res.redirect(back.toString());
  });

  // ------------------------------------------------------------------ token

  app.post('/token', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const grantType = String(body.grant_type ?? '');

    if (grantType === 'authorization_code') {
      const code = String(body.code ?? '');
      const verifier = String(body.code_verifier ?? '');
      const redirectUri = String(body.redirect_uri ?? '');

      const auth = store.takeAuthorization(code);

      if (!auth) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown, expired or used code.' });
        return;
      }

      if (auth.redirect_uri !== redirectUri || auth.client_id !== String(body.client_id ?? '')) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Code was issued for a different request.' });
        return;
      }

      if (!verifyPkce(auth.code_challenge, verifier)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
        return;
      }

      // A fresh sign-in: the session begins now.
      res.json(issueTokenPair(config, store, auth.client_id, auth.user_id, auth.user_name, Date.now()));
      return;
    }

    if (grantType === 'refresh_token') {
      const refresh = String(body.refresh_token ?? '');
      const stored = store.findToken(refresh, 'refresh');

      if (!stored) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired refresh token.' });
        return;
      }

      // Rotated, not reused: the old refresh token stops working the moment a new pair is
      // issued, so a stolen one is good only until its owner next refreshes.
      store.revokeToken(refresh);

      // The same session continues — its start time is carried over, not reset. Resetting it
      // here would make refreshing a way to walk out from under a revocation.
      res.json(issueTokenPair(
        config, store, stored.client_id, stored.user_id, stored.user_name,
        stored.session_started ?? Date.now(),
      ));
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

function issueTokenPair(
  config: Config,
  store: TokenStore,
  clientId: string,
  userId: number,
  userName: string,
  sessionStarted: number,
): Record<string, unknown> {
  const access = newSecret(32);
  const refresh = newSecret(32);

  store.issueToken(
    {
      kind: 'access',
      client_id: clientId,
      user_id: userId,
      user_name: userName,
      expires_at: Date.now() + config.accessTokenTtl * 1000,
      session_started: sessionStarted,
    },
    access,
  );

  store.issueToken(
    {
      kind: 'refresh',
      client_id: clientId,
      user_id: userId,
      user_name: userName,
      expires_at: Date.now() + config.refreshTokenTtl * 1000,
      session_started: sessionStarted,
    },
    refresh,
  );

  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: config.accessTokenTtl,
    refresh_token: refresh,
    scope: 'portal:read',
  };
}
