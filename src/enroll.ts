/**
 * The setup page — where a connector is given its service token.
 *
 * An administrator generates an enrolment code in the portal (Administration → Portal
 * Connector → Settings) and pastes it here. This service then invents a service token, sends
 * it to the portal to be registered, and keeps it. Nobody ever sees that token, and nothing on
 * this host has to be edited.
 *
 * This page is on the public internet, so it is worth being explicit about what an anonymous
 * visitor can get from it:
 *
 *   - It says whether this connector is enrolled, and when. Not the token, not the portal's
 *     address, not who signed in. Enough for the operator who is setting it up to know whether
 *     it worked, and nothing that helps anybody else.
 *   - Redeeming needs a code that an administrator generated minutes earlier and that works
 *     once. Guessing is bounded by the limiter below and by the portal's own.
 *
 * What it does NOT do is let a visitor UN-enrol a working connector, or re-enrol one without a
 * fresh code. Both would be a denial of service available to anyone who found the URL.
 */

import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';

import type { Config } from './config.js';
import { PortalError } from './portal.js';
import type { ServiceTokenStore } from './serviceToken.js';

/**
 * A small fixed-window limiter, per address.
 *
 * In memory and per process, which is the right size for the job: this endpoint is used once
 * in a connector's life, so the limiter exists to make code-guessing pointless rather than to
 * meter real traffic. The portal enforces its own limit too, and that one is the authority.
 */
class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    // Bounded so a flood cannot grow the map without limit; entries are dropped on the next
    // window anyway.
    if (this.hits.size > 10_000) this.hits.clear();

    entry.count += 1;

    return entry.count <= this.max;
  }
}

const limiter = new AttemptLimiter(10, 60_000);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Connector setup</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.55 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
    h1 { font-size: 1.3rem; margin-bottom: .25rem; }
    p { margin: .6rem 0; }
    .muted { opacity: .7; font-size: .9rem; }
    .ok { color: #1a7f37; }
    .bad { color: #b42318; }
    input[type=text] { width: 100%; padding: .55rem; font-family: ui-monospace, monospace; font-size: .95rem; box-sizing: border-box; }
    button { margin-top: .75rem; padding: .55rem 1.1rem; font-size: 1rem; cursor: pointer; }
    hr { margin: 1.75rem 0; border: none; border-top: 1px solid rgba(128,128,128,.35); }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function statusLine(tokens: ServiceTokenStore): string {
  const state = tokens.describe();

  if (state.source === 'enrolled') {
    return `<p class="ok">This connector is enrolled${
      state.enrolled_at ? ` (${escapeHtml(state.enrolled_at)})` : ''
    }${state.issued_by ? `, on a code issued by ${escapeHtml(state.issued_by)}` : ''}.</p>`;
  }

  if (state.source === 'env') {
    return '<p class="muted">This connector is using a token from its environment. Enrolling replaces it '
      + 'with one it manages itself.</p>';
  }

  return '<p class="bad">This connector has no token yet, so it cannot reach the portal.</p>';
}

export function registerSetupRoutes(app: Express, config: Config, tokens: ServiceTokenStore): void {
  app.get('/setup', (_req: Request, res: Response) => {
    res.type('html').send(page(`
      <h1>Connector setup</h1>
      ${statusLine(tokens)}
      <hr>
      <form method="POST" action="/setup">
        <label for="code">Enrolment code</label>
        <p class="muted">Generated in the portal under Administration → Portal Connector →
        Settings &amp; Activity → <strong>Connect a connector</strong>. It is valid for a few
        minutes and works once.</p>
        <input type="text" id="code" name="code" autocomplete="off" spellcheck="false" required>
        <button type="submit">Enrol this connector</button>
      </form>
    `));
  });

  app.post('/setup', async (req: Request, res: Response) => {
    const key = req.ip ?? 'unknown';

    if (!limiter.allow(key)) {
      res.status(429).type('html').send(page(
        '<h1>Too many attempts</h1><p class="bad">Wait a minute and try again.</p>',
      ));
      return;
    }

    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';

    if (code === '') {
      res.status(400).type('html').send(page(
        '<h1>Connector setup</h1><p class="bad">Paste the enrolment code from the portal.</p>'
        + '<p><a href="/setup">Back</a></p>',
      ));
      return;
    }

    // Invented here and nowhere else. 32 random bytes as hex comfortably clears the portal's
    // 32-character floor and is the same shape the portal's own generator produces, so an
    // operator comparing the two sees one kind of value rather than two.
    const serviceToken = randomBytes(32).toString('hex');

    try {
      const accepted = await enrollWithPortal(config, code, serviceToken);

      tokens.adopt(serviceToken, config.portalBaseUrl, accepted.issued_by ?? null);

      console.log(`[setup] enrolled with the portal (code issued by ${accepted.issued_by ?? 'unknown'})`);

      res.type('html').send(page(`
        <h1>Enrolled</h1>
        <p class="ok">This connector is now registered with ${escapeHtml(String(accepted.portal ?? 'the portal'))}
        and is ready to use.</p>
        <p class="muted">The token it registered was generated here and is stored here. Nobody needs to
        copy it, and the portal keeps only its hash.${
          accepted.previous_token_valid_for_minutes
            ? ` The previously registered token keeps working for ${
                Number(accepted.previous_token_valid_for_minutes)
              } more minutes.`
            : ''
        }</p>
        <p>Add this connector in Claude as a custom connector pointing at
        <code>${escapeHtml(config.issuer)}/mcp</code>.</p>
      `));
    } catch (error) {
      const message = error instanceof PortalError || error instanceof Error
        ? error.message
        : 'The portal could not be reached.';

      console.warn(`[setup] enrolment refused: ${message}`);

      res.status(400).type('html').send(page(`
        <h1>Connector setup</h1>
        <p class="bad">${escapeHtml(message)}</p>
        <p class="muted">Generate a fresh code in the portal and try again — a code works once and
        expires quickly.</p>
        <p><a href="/setup">Back</a></p>
      `));
    }
  });
}

interface EnrollmentAccepted {
  portal?: string;
  issued_by?: string;
  previous_token_valid_for_minutes?: number;
}

/**
 * Register a token with the portal.
 *
 * Deliberately not on PortalClient: every method there presents the service token, and this is
 * the one call made without one. Keeping it separate means no future edit can accidentally
 * make the bootstrap depend on the thing it bootstraps.
 */
async function enrollWithPortal(config: Config, code: string, serviceToken: string): Promise<EnrollmentAccepted> {
  const response = await fetch(`${config.portalBaseUrl}/internal/connector/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, service_token: serviceToken, connector_issuer: config.issuer }),
  });

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // Left null. An HTML body here means the portal answered with an error page, and its
    // status is more useful to report than its markup.
  }

  if (!response.ok) {
    throw new PortalError(
      (parsed as { message?: string } | null)?.message
        ?? `The portal refused the enrolment (HTTP ${response.status}).`,
      response.status,
      parsed,
    );
  }

  return ((parsed as { data?: EnrollmentAccepted } | null)?.data ?? {});
}
