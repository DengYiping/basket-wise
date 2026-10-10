import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { equalSecret, SCOPE, type Config } from "./config.js";

export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");
const secret = (): string => randomBytes(32).toString("base64url");
const APPLICATION_ID = 0x47504f43;

export interface Authorization {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  scope: string;
}

interface Interaction {
  id: string;
  browser_hash: string;
  csrf_hash: string;
  authorization: string;
  expires_at: number;
  decision: string;
}

interface Grant {
  id: string;
  guest_tag: string;
  client_id: string;
  resource: string;
  scope: string;
  expires_at: number;
  revoked: number;
}

interface Credential {
  hash: string;
  grant_id: string;
  kind: string;
  expires_at: number;
  used: number;
  redirect_uri: string | null;
  challenge: string | null;
}

export type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};
export type TokenResult =
  | { tokens: Tokens }
  | { error: "invalid_grant" | "invalid_target" | "invalid_scope" };

/** Synthetic OAuth state only. Never imports or opens the Basket Wise store. */
export class GuestAuthStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const id = this.db.prepare("PRAGMA application_id").get() as {
      application_id: number;
    };
    if (tables.length && id.application_id !== APPLICATION_ID) {
      this.db.close();
      throw new Error(
        "Refusing to use a database that does not belong to the isolated guest OAuth PoC.",
      );
    }
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      BEGIN IMMEDIATE;
      PRAGMA application_id = ${APPLICATION_ID};
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, csrf_hash TEXT NOT NULL,
        authorization TEXT NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY, guest_tag TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
        resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS credentials (
        hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
        redirect_uri TEXT, challenge TEXT
      );
      COMMIT;
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private cleanup(): void {
    this.db
      .prepare("DELETE FROM interactions WHERE expires_at <= ?")
      .run(this.now());
    this.db.prepare("DELETE FROM grants WHERE expires_at <= ?").run(this.now());
  }

  purge(): void {
    this.transaction(() => this.cleanup());
  }

  beginAuthorization(authorization: Authorization): {
    interaction: string;
    browser: string;
    csrf: string;
  } {
    return this.transaction(() => {
      this.cleanup();
      const count = this.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM interactions) + (SELECT COUNT(*) FROM grants) AS n",
        )
        .get() as { n: number };
      if (count.n >= 1000)
        throw new Error(
          "PoC capacity reached; wait for expiry or purge expired state.",
        );
      const interaction = secret(),
        browser = secret(),
        csrf = secret();
      this.db
        .prepare(
          "INSERT INTO interactions(id, browser_hash, csrf_hash, authorization, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          digest(interaction),
          digest(browser),
          digest(csrf),
          JSON.stringify(authorization),
          this.now() + 300_000,
        );
      return { interaction, browser, csrf };
    });
  }

  finishAuthorization(input: {
    interaction: string;
    browser: string;
    csrf: string;
    approve: boolean;
  }): { redirect: string } | { error: string } {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM interactions WHERE id = ?")
        .get(digest(input.interaction)) as unknown as Interaction | undefined;
      if (
        !row ||
        row.expires_at <= this.now() ||
        !equalSecret(row.browser_hash, digest(input.browser)) ||
        !equalSecret(row.csrf_hash, digest(input.csrf))
      ) {
        return { error: "Authorization interaction is invalid or expired." };
      }
      if (row.decision !== "pending")
        return {
          error:
            "Authorization interaction was already handled; start a fresh connection.",
        };
      const auth = JSON.parse(row.authorization) as Authorization;
      const redirect = new URL(auth.redirectUri);
      redirect.searchParams.set("state", auth.state);
      redirect.searchParams.set("iss", this.config.origin);
      this.db
        .prepare("UPDATE interactions SET decision = ? WHERE id = ?")
        .run(input.approve ? "approved" : "denied", row.id);
      if (!input.approve) {
        redirect.searchParams.set("error", "access_denied");
        return { redirect: redirect.href };
      }
      const grantId = randomUUID(),
        code = secret();
      this.db
        .prepare(
          "INSERT INTO grants(id, guest_tag, client_id, resource, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          grantId,
          `guest-${randomUUID()}`,
          auth.clientId,
          auth.resource,
          auth.scope,
          this.now() + this.config.guestTtlSeconds * 1000,
        );
      this.db
        .prepare(
          "INSERT INTO credentials(hash, grant_id, kind, expires_at, redirect_uri, challenge) VALUES (?, ?, 'code', ?, ?, ?)",
        )
        .run(
          digest(code),
          grantId,
          this.now() + 60_000,
          auth.redirectUri,
          auth.challenge,
        );
      redirect.searchParams.set("code", code);
      return { redirect: redirect.href };
    });
  }

  private issueTokens(grant: Grant): Tokens {
    const access = secret(),
      refresh = secret();
    const expiresIn = Math.min(
      this.config.accessTtlSeconds,
      Math.floor((grant.expires_at - this.now()) / 1000),
    );
    this.db
      .prepare(
        "INSERT INTO credentials(hash, grant_id, kind, expires_at) VALUES (?, ?, 'access', ?)",
      )
      .run(digest(access), grant.id, this.now() + expiresIn * 1000);
    this.db
      .prepare(
        "INSERT INTO credentials(hash, grant_id, kind, expires_at) VALUES (?, ?, 'refresh', ?)",
      )
      .run(digest(refresh), grant.id, grant.expires_at);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: grant.scope,
    };
  }

  exchange(input: {
    kind: "code" | "refresh";
    credential: string;
    clientId: string;
    resource?: string;
    redirectUri?: string;
    verifier?: string;
    scope?: string;
  }): TokenResult {
    return this.transaction(() => {
      const credential = this.db
        .prepare("SELECT * FROM credentials WHERE hash = ? AND kind = ?")
        .get(digest(input.credential), input.kind) as unknown as
        Credential | undefined;
      const grant = credential
        ? (this.db
            .prepare("SELECT * FROM grants WHERE id = ?")
            .get(credential.grant_id) as unknown as Grant | undefined)
        : undefined;
      if (
        !credential ||
        !grant ||
        grant.client_id !== input.clientId ||
        grant.revoked ||
        grant.expires_at - this.now() < 1000 ||
        credential.expires_at <= this.now()
      )
        return { error: "invalid_grant" };
      if (input.resource !== undefined && input.resource !== grant.resource)
        return { error: "invalid_target" };
      if (input.scope !== undefined && input.scope !== grant.scope)
        return { error: "invalid_scope" };
      if (
        input.kind === "code" &&
        (input.redirectUri !== credential.redirect_uri ||
          !input.verifier ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) ||
          !equalSecret(digest(input.verifier), credential.challenge ?? ""))
      )
        return { error: "invalid_grant" };
      if (credential.used) {
        // A code/refresh token is its persistent single-use operation key.
        // Replays never issue a second grant and revoke the affected family.
        this.db
          .prepare("UPDATE grants SET revoked = 1 WHERE id = ?")
          .run(grant.id);
        return { error: "invalid_grant" };
      }
      this.db
        .prepare("UPDATE credentials SET used = 1 WHERE hash = ?")
        .run(credential.hash);
      return { tokens: this.issueTokens(grant) };
    });
  }

  authenticate(
    access: string,
  ): { guestTag: string; scope: string; guestExpiresAt: number } | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(access)) return undefined;
    const row = this.db
      .prepare(
        `SELECT g.* FROM credentials c JOIN grants g ON g.id = c.grant_id
      WHERE c.hash = ? AND c.kind = 'access' AND c.expires_at > ? AND g.expires_at > ? AND g.revoked = 0`,
      )
      .get(digest(access), this.now(), this.now()) as unknown as
      Grant | undefined;
    if (
      !row ||
      row.client_id !== this.config.clientId ||
      row.resource !== `${this.config.origin}/mcp` ||
      row.scope !== SCOPE
    )
      return undefined;
    return {
      guestTag: row.guest_tag,
      scope: row.scope,
      guestExpiresAt: row.expires_at,
    };
  }

  revokeGuest(guestTag: string): boolean {
    return this.transaction(
      () =>
        this.db
          .prepare(
            "UPDATE grants SET revoked = 1 WHERE guest_tag = ? AND revoked = 0",
          )
          .run(guestTag).changes > 0,
    );
  }
}
