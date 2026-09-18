/**
 * The portal's internal API, as seen from here.
 *
 * Every tool call sends two things: the service token, which says "this is the connector", and
 * the user's GRANT, which says "on behalf of the person who consented". The grant is the secret
 * the portal issued when that person went through its consent screen; the portal resolves the
 * user, and when their session began, from its own record of it. Nothing in this file asserts
 * who the user is or what they may read — it cannot, and that is the arrangement that makes
 * this service safe to run outside the network perimeter.
 *
 * (It used to send `X-Connector-User: <id>`. With the service token, that let whoever held the
 * token act as anybody. The portal no longer accepts it.)
 */

import type { Config } from './config.js';

export interface PortalIdentity {
  /** Sent back as X-Connector-Grant on every call made for this user. */
  grant: string;
  user_id: number;
  name: string;
  email: string;
  roles: string[];
  is_admin: boolean;
}

/** Longest portal error message passed on — to Claude, or to a browser on /setup. */
const MAX_MESSAGE = 500;

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

/** A portal message fit to pass on: one line, bounded, never an HTML error page. */
export function portalMessage(raw: unknown, status: number): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';

  if (text === '' || text.startsWith('<')) {
    return `The portal refused the request (HTTP ${status}).`;
  }

  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
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
     * Called when the portal says this grant's session is over (an administrator ended it, or
     * it predates grants), so the tokens this service holds for it can be thrown away rather
     * than kept until they expire.
     */
    private readonly onSessionRevoked: (grant: string) => void = () => {},
    /** The acting user's grant. Set on a per-request clone; see forSession. */
    private readonly grant: string | null = null,
  ) {}

  /**
   * A copy of this client acting for one signed-in session.
   *
   * Made per request in index.ts, so the ten tools can keep calling `callTool(…)` without each
   * of them having to remember to pass the grant along — a thing ten call sites would
   * eventually get wrong in one place.
   */
  forSession(grant: string): PortalClient {
    return new PortalClient(this.config, this.serviceToken, this.onSessionRevoked, grant);
  }

  /** Redeem a portal authorization code for the identity behind it, and its grant. */
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
   * Call a tool endpoint on behalf of this session's user.
   *
   * `unknown` rather than a per-tool return type: these payloads go straight back to Claude as
   * text, and inventing TypeScript shapes for them here would be a second copy of the portal's
   * contract that nothing keeps in step with the first.
   */
  async callTool(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<unknown> {
    if (this.grant === null) {
      throw new PortalError('No signed-in session to act for.', 401, null);
    }

    return this.request<unknown>(method, path, { ...options, grant: this.grant });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown; grant?: string } = {},
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

    if (options.grant !== undefined) {
      headers['X-Connector-Grant'] = options.grant;
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // A portal that stops answering must not hold a Claude request — and this process's
        // sockets — open indefinitely.
        signal: AbortSignal.timeout(this.config.portalTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

      throw new PortalError(
        timedOut ? 'The portal did not answer in time. Try again shortly.' : 'The portal could not be reached.',
        504,
        null,
      );
    }

    const text = await response.text();
    let parsed: unknown = text;

    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // Left as text. A non-JSON body from the portal is usually an HTML error page — which
      // portalMessage() will not pass on.
    }

    if (!response.ok) {
      const message = portalMessage((parsed as { message?: unknown } | null)?.message, response.status);

      // The portal names this one refusal, because it is the only one that is an instruction
      // rather than an answer: this session is over, so the tokens held for it are to be
      // deleted, not retried. Every other refusal is information for the user.
      if (
        options.grant !== undefined
        && (parsed as { reason?: string } | null)?.reason === 'session_revoked'
      ) {
        this.onSessionRevoked(options.grant);
      }

      throw new PortalError(message, response.status, parsed);
    }

    return parsed as T;
  }
}
