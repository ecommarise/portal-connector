/**
 * Registered clients, pending authorizations, and live tokens.
 *
 * A JSON file behind an interface, not because a file is the right long-term home but because
 * the volume here is a handful of people on their own Claude accounts, and a database would be
 * one more thing to run, back up and get wrong for no gain at that size. The `TokenStore`
 * interface is the part that matters: swapping in Postgres or Redis later is one new class,
 * and nothing above this file changes.
 *
 * Tokens are stored HASHED. If this file is read — a stray backup, a misconfigured volume —
 * what leaks is a list of SHA-256 digests, not a set of working credentials. Same reasoning as
 * the portal hashing its authorization codes.
 *
 * Writes are atomic: serialise to a temp file, then rename. A process killed mid-write leaves
 * the previous complete file rather than a truncated one, which at 3am is the difference
 * between "restart it" and "everyone is logged out".
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}

/** An authorization in flight: issued at /authorize, redeemed at /token. */
export interface PendingAuthorization {
  /** Our authorization code, hashed. */
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user_id: number;
  user_name: string;
  expires_at: number;
  used: boolean;
}

/**
 * A leg of the journey between "the MCP client sent the user to us" and "the portal sent the
 * user back". Keyed by the state we hand the portal, so a reply cannot be attached to a
 * different login than the one that started it.
 */
export interface PendingPortalLogin {
  state: string;
  client_id: string;
  client_redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  expires_at: number;
}

export interface StoredToken {
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  user_id: number;
  user_name: string;
  expires_at: number;
  /**
   * When the SIGN-IN behind this token happened, carried unchanged through every refresh.
   *
   * Not the same as when the token was issued, and the difference is the whole point. A
   * refresh mints a new pair but continues the same session, so an administrator revoking at
   * 10:00 must kill a token minted at 10:05 from a session that began at 09:00. Stamping the
   * issue time instead would let anybody outrun a revocation by refreshing.
   *
   * Optional on the type because a store written by an older build has tokens without it;
   * those are treated as having begun at the dawn of time, which is the safe reading.
   */
  session_started?: number;
}

interface StoreShape {
  clients: OAuthClient[];
  authorizations: PendingAuthorization[];
  logins: PendingPortalLogin[];
  tokens: StoredToken[];
}

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export class TokenStore {
  private state: StoreShape = { clients: [], authorizations: [], logins: [], tokens: [] };

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });

    try {
      this.state = JSON.parse(readFileSync(file, 'utf8')) as StoreShape;
    } catch {
      // No file yet, or an unreadable one. Starting empty is correct for the first case and
      // survivable for the second: everyone signs in again, nothing is silently corrupted.
    }

    this.sweep();
  }

  static open(dataDir: string): TokenStore {
    return new TokenStore(join(dataDir, 'store.json'));
  }

  // ------------------------------------------------------------------ clients

  registerClient(clientName: string, redirectUris: string[]): OAuthClient {
    const client: OAuthClient = {
      client_id: newSecret(16),
      client_name: clientName,
      redirect_uris: redirectUris,
      created_at: Date.now(),
    };

    this.state.clients.push(client);
    this.flush();

    return client;
  }

  findClient(clientId: string): OAuthClient | undefined {
    return this.state.clients.find((c) => c.client_id === clientId);
  }

  // ------------------------------------------------------------------ portal login legs

  startPortalLogin(login: PendingPortalLogin): void {
    this.state.logins.push(login);
    this.flush();
  }

  takePortalLogin(state: string): PendingPortalLogin | undefined {
    const index = this.state.logins.findIndex((l) => l.state === state);
    if (index === -1) return undefined;

    const [login] = this.state.logins.splice(index, 1);
    this.flush();

    if (!login || login.expires_at < Date.now()) return undefined;

    return login;
  }

  // ------------------------------------------------------------------ authorization codes

  issueAuthorization(auth: PendingAuthorization): void {
    this.state.authorizations.push(auth);
    this.flush();
  }

  /**
   * Redeem a code. Single use — marked used before the caller can act on it, so two requests
   * arriving together cannot both succeed.
   */
  takeAuthorization(plainCode: string): PendingAuthorization | undefined {
    const hash = hashToken(plainCode);
    const found = this.state.authorizations.find((a) => a.code_hash === hash);

    if (!found || found.used || found.expires_at < Date.now()) return undefined;

    found.used = true;
    this.flush();

    return found;
  }

  // ------------------------------------------------------------------ tokens

  issueToken(token: Omit<StoredToken, 'token_hash'>, plain: string): void {
    this.state.tokens.push({ ...token, token_hash: hashToken(plain) });
    this.flush();
  }

  findToken(plain: string, kind: StoredToken['kind']): StoredToken | undefined {
    const hash = hashToken(plain);
    const found = this.state.tokens.find((t) => t.token_hash === hash && t.kind === kind);

    if (!found || found.expires_at < Date.now()) return undefined;

    return found;
  }

  /**
   * Throw away every token belonging to a session that began at or before `before`.
   *
   * Called when the portal says a user's sessions were ended. Deleting rather than marking
   * them dead: the portal refuses these calls regardless, so keeping the rows would buy
   * nothing except a file that still holds credentials somebody has decided to end.
   *
   * Returns how many went, for the log — "revoked 2 tokens for user 7" is the line that tells
   * an operator the sweep is actually doing something.
   */
  revokeSessionsStartedBefore(userId: number, before: number): number {
    const kept = this.state.tokens.filter(
      (t) => t.user_id !== userId || (t.session_started ?? 0) > before,
    );
    const removed = this.state.tokens.length - kept.length;

    if (removed > 0) {
      this.state.tokens = kept;
      this.flush();
    }

    return removed;
  }

  revokeToken(plain: string): void {
    const hash = hashToken(plain);
    this.state.tokens = this.state.tokens.filter((t) => t.token_hash !== hash);
    this.flush();
  }

  /** Drop everything expired. Called at boot and after each write. */
  sweep(): void {
    const now = Date.now();

    this.state.authorizations = this.state.authorizations.filter((a) => a.expires_at >= now && !a.used);
    this.state.logins = this.state.logins.filter((l) => l.expires_at >= now);
    this.state.tokens = this.state.tokens.filter((t) => t.expires_at >= now);
  }

  private flush(): void {
    this.sweep();

    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
