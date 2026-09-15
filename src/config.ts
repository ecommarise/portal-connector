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
      `${name} is not set. The connector cannot start without it — see connector/.env.example.`,
    );
  }

  return value.trim();
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

export interface Config {
  /** Public origin of THIS service, e.g. https://connector.ecommarise.com. No trailing slash. */
  issuer: string;
  port: number;

  /** Where the portal lives, reachable privately from here. No trailing slash. */
  portalBaseUrl: string;
  /** Shared secret for the portal's internal API. Matches CONNECTOR_SERVICE_TOKEN there. */
  portalServiceToken: string;

  /** Lifetimes, in seconds. */
  accessTokenTtl: number;
  refreshTokenTtl: number;
  authCodeTtl: number;

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

  return {
    issuer,
    port: optionalNumber('PORT', 8787),
    portalBaseUrl: required('PORTAL_BASE_URL').replace(/\/+$/, ''),
    portalServiceToken: required('PORTAL_SERVICE_TOKEN'),
    accessTokenTtl: optionalNumber('ACCESS_TOKEN_TTL', 3600),
    refreshTokenTtl: optionalNumber('REFRESH_TOKEN_TTL', 60 * 60 * 24 * 30),
    authCodeTtl: optionalNumber('AUTH_CODE_TTL', 60),
    dataDir: process.env.DATA_DIR?.trim() || 'data',
  };
}
