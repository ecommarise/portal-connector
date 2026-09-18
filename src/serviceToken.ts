/**
 * The service token this connector presents to the portal, and where it comes from.
 *
 * Two sources, in this order:
 *
 *   1. `data/service-token.json`, written when the connector enrolled itself.
 *   2. `PORTAL_SERVICE_TOKEN` in the environment.
 *
 * The file wins, and that ordering is the whole feature. Before enrolment existed, the token
 * reached this service by hand — generated on the portal's settings screen, copied through a
 * clipboard and a chat message, pasted into a `.env` on this host, service restarted. That
 * needs somebody with shell access here every time it changes, which is the real reason a
 * token that "should be rotated quarterly" is four years old.
 *
 * With enrolment, the plaintext is born here, in memory, and the only place it ever goes is
 * this file and one POST to the portal. Nobody reads it, so nobody has to be trusted with it.
 *
 * The env value stays supported, and not only for compatibility: a host still being built, or
 * a portal whose settings screen is unreachable, needs a way in that does not depend on the
 * connector already working.
 *
 * Stored in PLAINTEXT, unlike everything in TokenStore. It has to be — it is presented to the
 * portal on every call, so a hash would be useless. What protects it is the same thing that
 * protects `.env`: file permissions on a host that should hold nothing else. DEPLOYMENT.md §
 * "Where the data directory lives" says what that means in practice.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ServiceTokenSource = 'enrolled' | 'env' | 'none';

interface EnrolledToken {
  token: string;
  /** The portal this token was registered with. It is never presented anywhere else. */
  portal_base_url: string;
  enrolled_at: string;
  /** Older files carried the issuing administrator's name; it is no longer written or shown. */
  issued_by?: string | null;
}

export class ServiceTokenStore {
  private constructor(
    private readonly file: string,
    private readonly envToken: string | null,
    private enrolled: EnrolledToken | null,
  ) {}

  static open(dataDir: string, envToken: string | null): ServiceTokenStore {
    const file = join(dataDir, 'service-token.json');
    let enrolled: EnrolledToken | null = null;

    try {
      enrolled = JSON.parse(readFileSync(file, 'utf8')) as EnrolledToken;
    } catch {
      // No file yet, or an unreadable one. Either way there is nothing to adopt, and the env
      // fallback (or the setup page) takes over. Refusing to start here would turn a missing
      // optional file into an outage.
    }

    return new ServiceTokenStore(file, envToken, enrolled);
  }

  /**
   * The token to present to `portalBaseUrl`, or null when there is none for it.
   *
   * An enrolled token is only ever sent to the portal it was registered with. If PORTAL_BASE_URL
   * is changed — or mistyped — the live token is withheld rather than handed to whatever host
   * the new value names; the connector then needs enrolling against the new portal.
   */
  current(portalBaseUrl?: string): string | null {
    if (this.enrolled) {
      if (portalBaseUrl !== undefined && this.enrolled.portal_base_url !== portalBaseUrl) {
        if (!this.warnedMismatch) {
          console.warn(
            `[service-token] enrolled for ${this.enrolled.portal_base_url}, but PORTAL_BASE_URL is ${portalBaseUrl}; `
              + 'not sending it. Enrol again at /setup for the new portal.',
          );
          this.warnedMismatch = true;
        }
        return this.envToken;
      }
      return this.enrolled.token;
    }

    return this.envToken;
  }

  private warnedMismatch = false;

  source(): ServiceTokenSource {
    if (this.enrolled) return 'enrolled';
    if (this.envToken) return 'env';

    return 'none';
  }

  /** What the setup page and /healthz may say about it. Never the token, never a person. */
  describe(): { source: ServiceTokenSource; enrolled_at: string | null } {
    return {
      source: this.source(),
      enrolled_at: this.enrolled?.enrolled_at ?? null,
    };
  }

  /**
   * Record a token the portal has accepted.
   *
   * Written atomically — temp file, then rename — for the same reason as TokenStore: a process
   * killed mid-write must leave the previous working token, not half of the new one. A
   * connector that cannot read its own token is a connector that cannot re-enrol without
   * somebody logging into this host, which is exactly the situation enrolment exists to end.
   */
  adopt(token: string, portalBaseUrl: string): void {
    const record: EnrolledToken = {
      token,
      portal_base_url: portalBaseUrl,
      enrolled_at: new Date().toISOString(),
    };

    mkdirSync(dirname(this.file), { recursive: true });

    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);

    this.enrolled = record;
    this.warnedMismatch = false;
  }
}
