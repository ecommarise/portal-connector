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
 * The portal GRANT is the exception, and is stored as issued: it is presented to the portal on
 * every call made for that user, so a hash would be useless. On its own it is inert — the
 * portal only accepts it alongside the service token — but it is why this file must stay off
 * shared volumes (DEPLOYMENT.md).
 *
 * Writes are atomic: serialise to a temp file, then rename. A process killed mid-write leaves
 * the previous complete file rather than a truncated one, which at 3am is the difference
 * between "restart it" and "everyone is logged out".
 *
 * Bounded. /register and /authorize are reachable without signing in, so the file must not be
 * something an anonymous caller can grow: clients never used for 30 days are dropped, and the
 * number of clients and of logins in flight is capped.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_CLIENTS = 1_000;
const MAX_PENDING_LOGINS = 2_000;
const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEVER_USED_CLIENT_TTL_MS = 60 * 60 * 1000;

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
  /** Last time a token was issued to this client. Clients never used go after 30 days. */
  last_used_at?: number;
}

/** An authorization in flight: issued at /callback, redeemed at /token. */
export interface PendingAuthorization {
  /** Our authorization code, hashed. Also the token family the code starts. */
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user_id: number;
  user_name: string;
  /** The portal grant this sign-in produced — see portal.ts. */
  grant: string;
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
   * When the SIGN-IN behind this token happened, carried unchanged through every refresh. Used
   * to tidy tokens away when the portal reports a revocation; the portal itself decides from
   * its own record of the grant.
   */
  session_started?: number;
  /** The portal grant every call for this session presents. Missing on pre-grant tokens. */
  grant?: string;
  /**
   * Every token descended from one sign-in shares a family (the hash of the authorization code
   * that started it). Replaying a spent code or a rotated refresh token revokes the whole
   * family: one of the two holders is a thief, and we cannot tell which.
   */
  family?: string;
  /** A refresh token already exchanged. Kept until expiry only so a replay can be detected. */
  rotated?: boolean;
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

  /** Null when the store is full of clients that are still in use. */
  registerClient(clientName: string, redirectUris: string[]): OAuthClient | null {
    this.sweep();

    if (this.state.clients.length >= MAX_CLIENTS) return null;

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

  /** False when too many logins are already in flight — a flood, not a person. */
  startPortalLogin(login: PendingPortalLogin): boolean {
    this.sweep();

    if (this.state.logins.length >= MAX_PENDING_LOGINS) return false;

    this.state.logins.push(login);
    this.flush();

    return true;
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
   * arriving together cannot both succeed. A code presented a SECOND time revokes every token
   * the first redemption produced: the code leaked, and the tokens may be in the wrong hands.
   */
  takeAuthorization(plainCode: string): PendingAuthorization | undefined {
    const hash = hashToken(plainCode);
    const found = this.state.authorizations.find((a) => a.code_hash === hash);

    if (!found || found.expires_at < Date.now()) return undefined;

    if (found.used) {
      this.revokeFamily(found.code_hash);
      return undefined;
    }

    found.used = true;
    this.flush();

    return found;
  }

  // ------------------------------------------------------------------ tokens

  issueToken(token: Omit<StoredToken, 'token_hash'>, plain: string): void {
    this.state.tokens.push({ ...token, token_hash: hashToken(plain) });

    const client = this.findClient(token.client_id);
    if (client) client.last_used_at = Date.now();

    this.flush();
  }

  /** A live token of this kind. Rotated refresh tokens are NOT returned — see findRefresh. */
  findToken(plain: string, kind: StoredToken['kind']): StoredToken | undefined {
    const hash = hashToken(plain);
    const found = this.state.tokens.find((t) => t.token_hash === hash && t.kind === kind);

    if (!found || found.expires_at < Date.now() || found.rotated) return undefined;

    return found;
  }

  /**
   * Look a refresh token up for exchange. A token that was already rotated is a replay: the
   * whole family is revoked and nothing is returned.
   */
  findRefresh(plain: string): StoredToken | undefined {
    const hash = hashToken(plain);
    const found = this.state.tokens.find((t) => t.token_hash === hash && t.kind === 'refresh');

    if (!found || found.expires_at < Date.now()) return undefined;

    if (found.rotated) {
      if (found.family) this.revokeFamily(found.family);
      return undefined;
    }

    return found;
  }

  /** Mark a refresh token spent, keeping it only so a later replay can be recognised. */
  rotateRefresh(plain: string): void {
    const hash = hashToken(plain);
    const found = this.state.tokens.find((t) => t.token_hash === hash && t.kind === 'refresh');

    if (found) {
      found.rotated = true;
      this.flush();
    }
  }

  revokeFamily(family: string): number {
    const kept = this.state.tokens.filter((t) => t.family !== family);
    const removed = this.state.tokens.length - kept.length;

    if (removed > 0) {
      this.state.tokens = kept;
      this.flush();
      console.warn(`[oauth] a spent code or refresh token was replayed; revoked ${removed} token(s) of that sign-in`);
    }

    return removed;
  }

  /** Every token presenting this portal grant — one sign-in, however often refreshed. */
  revokeByGrant(grant: string): number {
    const kept = this.state.tokens.filter((t) => t.grant !== grant);
    const removed = this.state.tokens.length - kept.length;

    if (removed > 0) {
      this.state.tokens = kept;
      this.flush();
    }

    return removed;
  }

  /**
   * Throw away every token belonging to a session that began at or before `before`.
   *
   * Called when the portal reports a user's sessions were ended, with the portal's own
   * revocation time — so a session the user started AFTER the revocation survives.
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

  /** Drop everything expired, and clients nobody has used for a month. */
  sweep(): void {
    const now = Date.now();

    this.state.authorizations = this.state.authorizations.filter((a) => a.expires_at >= now);
    this.state.logins = this.state.logins.filter((l) => l.expires_at >= now);
    this.state.tokens = this.state.tokens.filter((t) => t.expires_at >= now);

    // A client that has held a token is kept for a month after it last did; one that never
    // completed a sign-in only for an hour. Otherwise a flood of registrations could fill the
    // store with dead clients and lock real ones out of registering for a month.
    const inUse = new Set(this.state.tokens.map((t) => t.client_id));
    this.state.clients = this.state.clients.filter((c) =>
      inUse.has(c.client_id)
      || (c.last_used_at !== undefined
        ? c.last_used_at > now - UNUSED_CLIENT_TTL_MS
        : c.created_at > now - NEVER_USED_CLIENT_TTL_MS));
  }

  private flush(): void {
    this.sweep();

    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
