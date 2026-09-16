/**
 * Keeping this service's token store in step with the portal's revocations.
 *
 * Two mechanisms end a session, and it is worth being clear about which one does the work:
 *
 *   1. The PORTAL refuses. Every tool call carries the moment its session began, and the
 *      portal refuses any call from a session that began before an administrator revoked it.
 *      That is the enforcement, it needs nothing from this file, and it holds even if this
 *      service is compromised — which is the reason the decision lives there and not here.
 *
 *   2. This sweep deletes the tokens. Enforcement alone leaves a revoked user's tokens sitting
 *      here, valid-looking, until they expire — up to thirty days. An MCP client that still
 *      holds one reconnects without a browser ever opening, and the person who pressed
 *      "revoke" watches the connection come straight back. Deleting them is what makes the
 *      next connect go through the consent screen.
 *
 * So: the portal decides, and this keeps the evidence tidy. Losing the sweep costs correct
 * behaviour a confusing appearance; losing the refusal would cost the revocation itself.
 */

import type { PortalClient } from './portal.js';
import type { TokenStore } from './oauth/store.js';

interface RevocationRow {
  user_id: number;
  revoked_at: string;
}

export class RevocationSweeper {
  /**
   * The portal's clock at the last successful poll, echoed back so it only sends what is new.
   *
   * Null until the first poll, which therefore asks for everything. That is deliberate: this
   * service restarts with a token store that may predate revocations made while it was down,
   * and a first poll that asked only for "since I started" would miss exactly those.
   */
  private asOf: string | null = null;

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly portal: PortalClient,
    private readonly store: TokenStore,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    void this.sweep();

    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    // Not a reason to keep the process alive on its own — if everything else has finished,
    // a polling timer should not be what holds the door open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    try {
      const body = await this.portal.revocations(this.asOf) as {
        data?: { revocations?: RevocationRow[]; as_of?: string };
      };

      const rows = body?.data?.revocations ?? [];

      for (const row of rows) {
        const before = Date.parse(row.revoked_at);

        if (!Number.isFinite(before)) continue;

        const removed = this.store.revokeSessionsStartedBefore(row.user_id, before);

        if (removed > 0) {
          console.log(`[revocations] dropped ${removed} token(s) for user ${row.user_id}`);
        }
      }

      // Advanced only on success. A failed poll must not move the watermark past revocations
      // it never saw — the next poll would then never hear about them.
      if (body?.data?.as_of) this.asOf = body.data.as_of;
    } catch (error) {
      // Warned, not thrown. The portal being briefly unreachable is not a reason to stop
      // serving: the refusal path is still enforcing every revocation, so the only thing
      // being deferred is the tidying.
      console.warn(
        `[revocations] poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
