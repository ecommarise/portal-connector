/**
 * The portal's internal API, as seen from here.
 *
 * Every method sends two things: the service token, which says "this is the connector", and
 * the acting user id, which says "on whose behalf". The portal decides the rest. Nothing in
 * this file asserts what a user may read — it cannot, and the portal would ignore it if it
 * tried, which is the arrangement that makes this service safe to run outside the network
 * perimeter.
 */

import type { Config } from './config.js';

export interface PortalIdentity {
  user_id: number;
  name: string;
  email: string;
  roles: string[];
  is_admin: boolean;
}

export class PortalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'PortalError';
  }
}

export class PortalClient {
  /**
   * The token is read through a function, not captured once.
   *
   * Enrolment can replace it while the process is running — that is the point of enrolment —
   * and a client holding a copy from boot would keep presenting the old one until somebody
   * restarted the service, which is the restart enrolment exists to avoid.
   */
  constructor(
    private readonly config: Config,
    private readonly serviceToken: () => string | null,
    /**
     * Called when the portal says a user's sessions were ended, so the tokens this service is
     * holding can be thrown away rather than kept until they expire.
     *
     * A callback rather than a direct TokenStore reference: this file is about talking to the
     * portal, and nothing else here knows or should know how tokens are stored.
     */
    private readonly onSessionRevoked: (userId: number) => void = () => {},
    /** When the acting user's sign-in happened. Set on a per-request clone; see forSession. */
    private readonly sessionStarted: number | null = null,
  ) {}

  /**
   * A copy of this client stamped with one session's start time.
   *
   * Made per request in index.ts, so the ten tools can keep calling `callTool(userId, …)`
   * without each of them having to remember to pass a session along — a thing ten call sites
   * would eventually get wrong in one place.
   */
  forSession(sessionStarted: number): PortalClient {
    return new PortalClient(this.config, this.serviceToken, this.onSessionRevoked, sessionStarted);
  }

  /** Redeem a portal authorization code for the identity behind it. */
  async exchange(code: string, redirectUri: string): Promise<PortalIdentity> {
    const body = await this.request<{ data: PortalIdentity }>('POST', '/exchange', {
      body: { code, redirect_uri: redirectUri },
    });

    return body.data;
  }

  /**
   * Which users have had their connector sessions ended.
   *
   * Asked on this service's own behalf, with no acting user — it is a question about
   * everybody, and the answer is what lets this service delete tokens it should not keep.
   */
  async revocations(since: string | null): Promise<unknown> {
    return this.request<unknown>('GET', '/revocations', {
      query: since ? { since } : {},
    });
  }

  /**
   * Call a tool endpoint on behalf of a user.
   *
   * `unknown` rather than a per-tool return type: these payloads go straight back to Claude as
   * text, and inventing TypeScript shapes for them here would be a second copy of the portal's
   * contract that nothing keeps in step with the first.
   */
  async callTool(
    userId: number,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<unknown> {
    return this.request<unknown>(method, path, { ...options, userId });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown; userId?: number } = {},
  ): Promise<T> {
    const url = new URL(`${this.config.portalBaseUrl}/internal/connector${path}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const token = this.serviceToken();

    if (!token) {
      // Said in full rather than letting the portal answer 401, because the remedy is here,
      // not there: this connector has never been given a token, and the person reading this
      // needs to be sent to the setup page rather than to the portal's logs.
      throw new PortalError(
        'This connector has not been enrolled yet. An administrator generates an enrolment code '
          + `in the portal under Administration → Portal Connector → Settings, then pastes it at ${this.config.issuer}/setup.`,
        503,
        null,
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    if (options.userId !== undefined) {
      headers['X-Connector-User'] = String(options.userId);

      // Seconds, because that is what the portal parses, and because a millisecond precision
      // the portal immediately truncates would only invite the two sides to disagree by less
      // than a second at exactly the wrong moment.
      if (this.sessionStarted !== null) {
        headers['X-Connector-Session-Started'] = String(Math.floor(this.sessionStarted / 1000));
      }
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let parsed: unknown = text;

    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // Left as text. A non-JSON body from the portal is usually an HTML error page, and
      // seeing it is far more useful than a parse error that hides it.
    }

    if (!response.ok) {
      const message =
        (parsed as { message?: string } | null)?.message ??
        `The portal refused the request (HTTP ${response.status}).`;

      // The portal names this one refusal, because it is the only one that is an instruction
      // rather than an answer: an administrator ended this person's sessions, so the tokens
      // held here are to be deleted, not retried. Every other refusal is information for the
      // user and is passed along untouched.
      if (
        options.userId !== undefined
        && (parsed as { reason?: string } | null)?.reason === 'session_revoked'
      ) {
        this.onSessionRevoked(options.userId);
      }

      throw new PortalError(message, response.status, parsed);
    }

    return parsed as T;
  }
}
