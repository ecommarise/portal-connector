/**
 * Everything this service needs from its environment, validated once at boot.
 *
 * Validated at boot rather than at first use on purpose: a connector that starts happily and
 * then fails on its first real tool call has already told Claude it is healthy, and the
 * failure surfaces to a user mid-question instead of to whoever deployed it.
 */

function required(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is not set. The connector cannot start without it — see .env.example.`,
    );
  }

  return value.trim();
}

function optionalString(name: string): string | null {
  const value = process.env[name]?.trim();

  return value ? value : null;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

function list(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

/** True for http://localhost, http://127.0.0.1 and http://[::1] — development only. */
export function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export interface Config {
  /** Public origin of THIS service, e.g. https://connector.ecommarise.com. No trailing slash. */
  issuer: string;
  port: number;

  /** Where the portal lives, reachable privately from here. No trailing slash. */
  portalBaseUrl: string;
  /**
   * Shared secret for the portal's internal API, if one was supplied in the environment.
   *
   * Optional, and null in the normal case. A connector is meant to be ENROLLED: an
   * administrator generates a code on the portal's settings screen, pastes it into this
   * service's /setup page, and this service invents its own token and registers it. See
   * ServiceTokenStore for why that is worth the extra endpoint.
   *
   * Set it only when the setup page cannot be reached — a host being built, or a recovery.
   * An enrolled token always wins over this value.
   */
  portalServiceTokenFromEnv: string | null;

  /** How long a call to the portal may take before it is abandoned, in milliseconds. */
  portalTimeoutMs: number;

  /**
   * Hosts an MCP client may register an https redirect URI on (the host itself or any of its
   * subdomains). Loopback http is always allowed, for desktop clients and development.
   *
   * Registration used to accept ANY redirect URI, so anybody could register a client pointing
   * at their own server and send a user a sign-in link: the user approves on the real portal
   * consent screen and the code — and a 30-day session — goes to the attacker.
   */
  allowedRedirectHosts: string[];

  /**
   * Express `trust proxy`. Default `loopback`: a reverse proxy on this host (Caddy, nginx) is
   * trusted to report the caller's address, anything else is not. Without it every visitor
   * looked like 127.0.0.1 behind the proxy and shared one rate-limit bucket.
   */
  trustProxy: string;

  /** Lifetimes, in seconds. */
  accessTokenTtl: number;
  refreshTokenTtl: number;
  authCodeTtl: number;

  /**
   * How often to ask the portal which sessions have been revoked, in seconds.
   *
   * This is a tidying interval, not an enforcement one — the portal refuses a revoked
   * session's calls immediately regardless. What the interval bounds is how long a revoked
   * user's MCP client can still RECONNECT without a browser, which is the thing that makes a
   * revocation look as though it did not happen.
   */
  revocationPollSeconds: number;

  /** Where the token store file lives. */
  dataDir: string;
}

export function loadConfig(): Config {
  const issuer = required('CONNECTOR_ISSUER').replace(/\/+$/, '');

  if (!issuer.startsWith('https://') && !issuer.startsWith('http://localhost')) {
    // OAuth 2.1 requires HTTPS for everything except loopback development. Refusing here
    // rather than warning, because an issuer served over plain HTTP hands every token to
    // anyone on the path, and a warning in a log is not a thing anybody reads.
    throw new Error('CONNECTOR_ISSUER must be an https:// URL (http://localhost is allowed for development).');
  }

  const portalBaseUrl = required('PORTAL_BASE_URL').replace(/\/+$/, '');
  const portalUrl = new URL(portalBaseUrl);

  // The service token travels on every portal call, and with it anybody can call the portal's
  // internal API. Over plain http it can be read off the wire by anything on that network.
  // Refused unless the operator says, explicitly, that the path is private and encrypted
  // underneath (a WireGuard tunnel, an SSH tunnel) — and even then it is said at every boot.
  if (portalUrl.protocol !== 'https:' && !isLoopbackHttp(portalUrl)) {
    if (process.env.PORTAL_ALLOW_HTTP !== 'true') {
      throw new Error(
        'PORTAL_BASE_URL must be https:// — the service token is sent on every call. If the portal is '
          + 'reached over an encrypted private tunnel (WireGuard, SSH), set PORTAL_ALLOW_HTTP=true to say so.',
      );
    }

    console.warn(
      `[config] PORTAL_BASE_URL is plain http (${portalUrl.origin}). PORTAL_ALLOW_HTTP=true says this path is `
        + 'an encrypted private tunnel; if it is not, the service token is readable on the network.',
    );
  }

  return {
    issuer,
    port: optionalNumber('PORT', 8787),
    portalBaseUrl,
    portalServiceTokenFromEnv: optionalString('PORTAL_SERVICE_TOKEN'),
    portalTimeoutMs: optionalNumber('PORTAL_TIMEOUT_MS', 15_000),
    allowedRedirectHosts: list('ALLOWED_REDIRECT_HOSTS', 'claude.ai,claude.com'),
    trustProxy: process.env.TRUST_PROXY?.trim() || 'loopback',
    accessTokenTtl: optionalNumber('ACCESS_TOKEN_TTL', 3600),
    refreshTokenTtl: optionalNumber('REFRESH_TOKEN_TTL', 60 * 60 * 24 * 30),
    authCodeTtl: optionalNumber('AUTH_CODE_TTL', 60),
    revocationPollSeconds: optionalNumber('REVOCATION_POLL_SECONDS', 60),
    dataDir: process.env.DATA_DIR?.trim() || 'data',
  };
}
