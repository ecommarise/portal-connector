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
  constructor(private readonly config: Config) {}

  /** Redeem a portal authorization code for the identity behind it. */
  async exchange(code: string, redirectUri: string): Promise<PortalIdentity> {
    const body = await this.request<{ data: PortalIdentity }>('POST', '/exchange', {
      body: { code, redirect_uri: redirectUri },
    });

    return body.data;
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

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.portalServiceToken}`,
      Accept: 'application/json',
    };

    if (options.userId !== undefined) {
      headers['X-Connector-User'] = String(options.userId);
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

      throw new PortalError(message, response.status, parsed);
    }

    return parsed as T;
  }
}
