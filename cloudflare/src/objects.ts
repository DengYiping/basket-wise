import { DurableObject } from "cloudflare:workers";
import {
  shoppingListActionSchema,
  type ShoppingListItem,
  type ShoppingListSnapshot,
} from "./shopping-list.js";
import {
  calculateThresholdAction,
  thresholdActionSchema,
  summarizeThresholds,
  suggestRemovals,
  type ThresholdAction,
  type ThresholdTrip,
} from "./thresholds.js";
import type {
  Authorization,
  ClientMetadata,
  Credential,
  Env,
  Flow,
  Meta,
  RegisteredClient,
} from "./types.js";
import {
  ACCESS_TTL,
  CODE_TTL,
  PROFILE_TTL,
  LEGACY_PROFILE_CUTOFF,
  DAY,
  FLOW_TTL,
  Failure,
  canonical,
  hash,
  id,
  issuance,
  isDynamicClient,
  requireValue,
} from "./security.js";

class Documents extends DurableObject<Env> {
  exists() {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
        )
        .toArray().length > 0
    );
  }
  install() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get<T>(key: string): T | undefined {
    if (!this.exists()) return undefined;
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM documents WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT INTO documents VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  remove(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM documents WHERE key = ?", key);
  }
  rows<T>(prefix: string): { key: string; value: T }[] {
    if (!this.exists()) return [];
    return this.ctx.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM documents WHERE key >= ? AND key < ? ORDER BY key",
        prefix,
        `${prefix}\uffff`,
      )
      .toArray()
      .map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }
  count(prefix: string): number {
    if (!this.exists()) return 0;
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE key >= ? AND key < ?",
        prefix,
        `${prefix}\uffff`,
      )
      .toArray()[0]!.count;
  }
}

export async function track(
  env: Env,
  kind: "vault" | "flow",
  locator: string,
  deadline: number,
) {
  await env.CLEANUP.getByName(`gc-${locator[0]}`).track(
    kind,
    locator,
    deadline,
  );
}

/** Empty construction is read-only: an obsolete credential must not resurrect storage. */
export class GuestVault extends Documents {
  // All callers run this inside a storage transaction. Expiry and the next
  // authenticated operation therefore observe one coherent generation.
  private active(): Meta {
    const meta = this.get<Meta>("meta");
    requireValue(meta, "guest_expired", 401);
    if (meta.schemaVersion !== 2) {
      requireValue(meta.expires > LEGACY_PROFILE_CUTOFF, "guest_expired", 401);
      meta.basketExpires = meta.expires;
      meta.expires = meta.expires - DAY + PROFILE_TTL;
      meta.schemaVersion = 2;
      meta.dataEpoch = crypto.randomUUID();
      // Legacy refresh credentials had a 30-day storage deadline. Upgrade
      // those still present to the new policy, bounded by this profile's clock.
      for (const row of this.rows<Credential>("refresh/")) {
        row.value.expires = Math.min(
          row.value.expires + 60 * DAY,
          meta.expires,
        );
        this.put(row.key, row.value);
      }
      // Retain hashes, not shopping snapshots, for retry detection after purge.
      for (const prefix of ["operation/", "activity/"])
        for (const row of this.rows<{ fingerprint: string }>(prefix))
          this.put(`replay/${row.key}`, {
            fingerprint: row.value.fingerprint,
            expires: meta.expires,
          });
      this.put("meta", meta);
    }
    requireValue(meta.expires > Date.now(), "guest_expired", 401);
    if (meta.basketExpires != null && meta.basketExpires <= Date.now())
      this.clearData(meta, true);
    return meta;
  }
  private clearData(meta: Meta, expired: boolean) {
    for (const prefix of ["trip/", "operation/", "activity/"])
      for (const row of this.rows(prefix)) this.remove(row.key);
    this.remove("current");
    meta.revision++;
    meta.dataEpoch = crypto.randomUUID();
    meta.basketExpires = null;
    if (expired) meta.lastBasketExpiredAt = Date.now();
    else delete meta.lastBasketExpiredAt;
    this.put("meta", meta);
  }
  private deadline(meta: Meta) {
    return Math.min(
      meta.expires,
      meta.basketExpires ?? Infinity,
      Date.now() + DAY,
    );
  }
  private pruneCredentials() {
    for (const prefix of [
      "code/",
      "access/",
      "refresh/",
      "control/",
      "replay/",
    ])
      for (const row of this.rows<{ expires: number }>(prefix))
        if (row.value.expires <= Date.now()) this.remove(row.key);
  }
  private grantAllowed(grant: string, expectedClient?: string) {
    const g = this.get<{
      revoked: boolean;
      client: string;
      clientExpiresAt?: number;
      resource: string;
      scope: string;
    }>(`grant/${grant}`);
    return (
      g &&
      !g.revoked &&
      (!expectedClient || g.client === expectedClient) &&
      (g.client === this.env.CLIENT_ID ||
        (this.env.DCR_ENABLED === "true" && isDynamicClient(g.client))) &&
      g.resource === `${this.env.PUBLIC_ORIGIN}/mcp` &&
      g.scope === "basket:manage"
    );
  }
  private credential(
    digest: string,
    kind: Credential["kind"],
  ): { meta: Meta; credential: Credential } {
    const meta = this.active(),
      credential = this.get<Credential>(`${kind}/${digest}`);
    requireValue(
      credential &&
        !credential.used &&
        credential.expires > Date.now() &&
        this.grantAllowed(credential.grant),
      "invalid_token",
      401,
    );
    return { meta, credential };
  }
  checkRecovery(digest: string) {
    this.ctx.storage.transactionSync(() => {
      requireValue(this.active().recovery === digest, "invalid_recovery", 401);
    });
  }
  async authorize(input: {
    flow: string;
    locator: string;
    deadline: number;
    authorization: Authorization;
    codeHash: string;
    recoveryHash: string;
    previousRecovery?: string;
  }) {
    requireValue(input.deadline > Date.now(), "flow_expired");
    this.ctx.storage.transactionSync(() => {
      const previous = this.get<{ codeHash: string }>(`issuance/${input.flow}`);
      if (previous) {
        this.active();
        requireValue(previous.codeHash === input.codeHash);
        // A lost acknowledgement response may retry this issuance, but must
        // never reactivate a used, expired, or subsequently revoked grant.
        if (input.previousRecovery) this.activateCodeRecord(input.codeHash);
        return;
      }
      let meta = this.get<Meta>("meta");
      if (input.previousRecovery) {
        meta = this.active();
        requireValue(
          meta.recovery === input.previousRecovery,
          "invalid_recovery",
          401,
        );
        // Called only after the browser acknowledges saving the replacement.
        // Commit takeover and code activation atomically; retain trips/receipts.
        for (const r of this.rows<{ revoked: boolean }>("grant/"))
          this.put(r.key, { revoked: true });
        meta.recovery = input.recoveryHash;
      } else {
        requireValue(!meta, "already_initialized", 409);
        this.install();
        meta = {
          id: input.locator,
          label: crypto.randomUUID(),
          expires: Date.now() + PROFILE_TTL,
          revision: 0,
          recovery: input.recoveryHash,
          created: Date.now(),
          schemaVersion: 2,
          basketExpires: null,
          dataEpoch: crypto.randomUUID(),
        };
      }
      requireValue(this.count("grant/") < 256, "guest_limit", 429);
      this.put("meta", meta);
      this.put(`grant/${input.flow}`, {
        revoked: false,
        client: input.authorization.clientId,
        ...(input.authorization.clientExpiresAt === undefined
          ? {}
          : { clientExpiresAt: input.authorization.clientExpiresAt }),
        resource: input.authorization.resource,
        scope: input.authorization.scope,
      });
      this.put(`code/${input.codeHash}`, {
        kind: "code",
        grant: input.flow,
        used: false,
        expires: input.deadline,
        activated: false,
        challenge: input.authorization.challenge,
        redirectUri: input.authorization.redirectUri,
      } satisfies Credential);
      this.put(`issuance/${input.flow}`, { codeHash: input.codeHash });
      if (input.previousRecovery) this.activateCodeRecord(input.codeHash);
    });
    await this.ctx.storage.setAlarm(this.deadline(this.get<Meta>("meta")!));
  }
  activateCode(digest: string) {
    this.ctx.storage.transactionSync(() => {
      this.activateCodeRecord(digest);
    });
  }
  private activateCodeRecord(digest: string) {
    const meta = this.active(),
      c = this.get<Credential>(`code/${digest}`);
    requireValue(c && !c.used && this.grantAllowed(c.grant), "invalid_grant");
    if (!c.activated) {
      c.expires = Math.min(Date.now() + CODE_TTL, meta.expires);
      c.activated = true;
      this.put(`code/${digest}`, c);
    }
    requireValue(c.expires > Date.now(), "invalid_grant");
  }
  async exchange(input: {
    clientId: string;
    kind: "code" | "refresh";
    digest: string;
    challenge?: string;
    redirectUri?: string;
    accessHash: string;
    refreshHash: string;
  }) {
    const result = this.ctx.storage.transactionSync(() => {
      const meta = this.active(),
        c = this.get<Credential>(`${input.kind}/${input.digest}`);
      // Check client binding before replay handling; another client must not
      // consume the code, rotate a refresh token, or revoke its grant family.
      requireValue(
        c && this.grantAllowed(c.grant, input.clientId),
        "invalid_grant",
      );
      if (input.kind === "code")
        requireValue(
          c.activated &&
            c.challenge === input.challenge &&
            c.redirectUri === input.redirectUri,
          "invalid_grant",
        );
      if (c.used) {
        this.put(`grant/${c.grant}`, { revoked: true });
        return { error: "invalid_grant" };
      }
      requireValue(
        c.expires > Date.now() && meta.expires - Date.now() >= 1000,
        "invalid_grant",
      );
      this.pruneCredentials();
      requireValue(
        this.count("access/") + this.count("refresh/") < 32768,
        "guest_limit",
        429,
      );
      c.used = true;
      this.put(`${input.kind}/${input.digest}`, c);
      const expires = Math.min(Date.now() + ACCESS_TTL, meta.expires);
      this.put(`access/${input.accessHash}`, {
        kind: "access",
        grant: c.grant,
        used: false,
        expires,
      } satisfies Credential);
      this.put(`refresh/${input.refreshHash}`, {
        kind: "refresh",
        grant: c.grant,
        used: false,
        expires: Math.min(Date.now() + PROFILE_TTL, meta.expires),
      } satisfies Credential);
      return { expiresIn: Math.floor((expires - Date.now()) / 1000) };
    });
    if ("error" in result) throw new Failure(result.error!);
    return result;
  }
  check(digest: string) {
    return this.ctx.storage.transactionSync(() => {
      const { meta } = this.credential(digest, "access");
      return { expiresAt: meta.expires, revision: meta.revision };
    });
  }
  profile(digest: string) {
    return this.ctx.storage.transactionSync(() => {
      const { meta } = this.credential(digest, "access");
      return { id: meta.label };
    });
  }

  private listView(meta: Meta): ShoppingListSnapshot {
    return {
      spaceId: meta.label,
      shoppingListRevision: meta.shoppingListRevision ?? 0,
      shoppingList: this.rows<ShoppingListItem>("list-item/").map(
        (r) => r.value,
      ),
      profileExpiresAt: meta.expires,
      alreadyApplied: false,
    };
  }
  async shoppingList(
    digest: string,
    raw: unknown,
    expectedShoppingListRevision?: number,
    activityId?: string,
  ) {
    const action = shoppingListActionSchema.parse(raw);
    const writing = "operationId" in action;
    requireValue(
      writing ||
        (typeof activityId === "string" &&
          activityId.length >= 8 &&
          activityId.length <= 128),
    );
    const fingerprint = await hash(
      canonical({
        action,
        ...(writing ? { expectedShoppingListRevision } : {}),
      }),
    );
    const key = `list-receipt/${writing ? "operation" : "activity"}/${writing ? action.operationId : activityId}`;
    const result = this.ctx.storage.transactionSync(() => {
      const { meta } = this.credential(digest, "access");
      const prior = this.get<{ fingerprint: string; itemId?: string }>(key);
      if (prior) {
        requireValue(
          prior.fingerprint === fingerprint,
          "operation_conflict",
          409,
        );
        return {
          ...this.listView(meta),
          ...(prior.itemId ? { itemId: prior.itemId } : {}),
          alreadyApplied: true,
        };
      }
      // Receipts last for the profile, not the basket generation. Never evict a
      // receipt and accidentally permit a delayed retry to recreate an entry.
      requireValue(this.count("list-receipt/") < 32768, "guest_limit", 429);
      let itemId: string | undefined;
      if (writing) {
        requireValue(
          expectedShoppingListRevision === (meta.shoppingListRevision ?? 0),
          "shopping_list_conflict",
          409,
        );
        if (action.kind === "add_shopping_list_item") {
          requireValue(this.count("list-item/") < 500, "guest_limit", 429);
          itemId = crypto.randomUUID();
          const { kind: _kind, operationId: _id, ...fields } = action;
          this.put(`list-item/${itemId}`, { ...fields, id: itemId });
        } else {
          itemId = action.itemId;
          const item = this.get<ShoppingListItem>(`list-item/${itemId}`);
          requireValue(item, "shopping_list_item_not_found", 404);
          if (action.kind === "update_shopping_list_item")
            this.put(`list-item/${itemId}`, { ...item, ...action.patch });
          else this.remove(`list-item/${itemId}`);
        }
        meta.shoppingListRevision = (meta.shoppingListRevision ?? 0) + 1;
      }
      // List activity renews the anonymous profile only. It cannot keep old
      // baskets alive or resurrect their generation.
      meta.expires = Date.now() + PROFILE_TTL;
      this.put("meta", meta);
      this.put(key, { fingerprint, ...(itemId ? { itemId } : {}) });
      return { ...this.listView(meta), ...(itemId ? { itemId } : {}) };
    });
    await this.ctx.storage.setAlarm(this.deadline(this.get<Meta>("meta")!));
    return result;
  }

  async basket(
    digest: string,
    raw: unknown,
    expectedRevision?: number,
    activityId?: string,
    dataEpoch?: string,
  ) {
    const action = thresholdActionSchema.parse(raw) as ThresholdAction;
    // Schema strips unknown fields; callers must not smuggle a token/owner/snapshot in an action.
    const allowed = new Set(Object.keys(action));
    requireValue(
      raw &&
        typeof raw === "object" &&
        Object.keys(raw).every((k) => allowed.has(k)),
    );
    const writing = "operationId" in action;
    requireValue(
      writing ||
        (typeof activityId === "string" &&
          activityId.length >= 8 &&
          activityId.length <= 128),
    );
    const fingerprint = await hash(canonical(action));
    const initial = this.ctx.storage.transactionSync(
      () => this.credential(digest, "access").meta,
    );
    if (writing)
      requireValue(dataEpoch === initial.dataEpoch, "data_expired", 409);
    const receiptKey = writing
      ? `operation/${action.operationId}`
      : `activity/${activityId}`;
    const prior = this.get<{
      fingerprint: string;
      result: Record<string, unknown>;
    }>(receiptKey);
    if (prior) {
      requireValue(
        prior.fingerprint === fingerprint,
        "operation_conflict",
        409,
      );
      return {
        ...(writing
          ? prior.result
          : this.view(action, initial, this.selectTrip(action))),
        alreadyApplied: true,
      }; // Never advances inactivity.
    }
    const old = this.get<{ fingerprint: string }>(`replay/${receiptKey}`);
    if (old) {
      requireValue(old.fingerprint === fingerprint, "operation_conflict", 409);
      requireValue(!writing, "data_expired", 409);
      return {
        ...this.view(action, initial, this.selectTrip(action)),
        alreadyApplied: true,
      };
    }
    const trip = this.selectTrip(action);
    let calculated:
      Awaited<ReturnType<typeof calculateThresholdAction>> | undefined;
    if (writing) {
      requireValue(
        expectedRevision === initial.revision,
        "revision_conflict",
        409,
      );
      calculated = await calculateThresholdAction(trip, action);
    }
    const result = this.ctx.storage.transactionSync(() => {
      const { meta } = this.credential(digest, "access");
      if (writing)
        requireValue(dataEpoch === meta.dataEpoch, "data_expired", 409);
      const repeated = this.get<{
        fingerprint: string;
        result: Record<string, unknown>;
      }>(receiptKey);
      if (repeated) {
        requireValue(
          repeated.fingerprint === fingerprint,
          "operation_conflict",
          409,
        );
        return {
          ...(writing
            ? repeated.result
            : this.view(action, meta, this.selectTrip(action))),
          alreadyApplied: true,
        };
      }
      requireValue(this.count("replay/") < 32768, "guest_limit", 429);
      if (writing) {
        requireValue(
          meta.revision === expectedRevision,
          "revision_conflict",
          409,
        );
        requireValue(this.count("operation/") < 10000, "guest_limit", 429);
        if (action.kind === "start_trip")
          requireValue(this.count("trip/") < 100, "guest_limit", 429);
        const next = calculated!.trip;
        if (action.kind === "add_item" && action.shoppingListItemId) {
          requireValue(
            action.expectedShoppingListRevision ===
              (meta.shoppingListRevision ?? 0),
            "shopping_list_conflict",
            409,
          );
          requireValue(
            this.get(`list-item/${action.shoppingListItemId}`),
            "shopping_list_item_not_found",
            404,
          );
          this.remove(`list-item/${action.shoppingListItemId}`);
          meta.shoppingListRevision = (meta.shoppingListRevision ?? 0) + 1;
        }
        this.put(`trip/${next.id}`, next);
        this.put("current", next.id);
        meta.revision++;
      }
      // Only first successful foreground domain calls count. OAuth/refresh/retries never do.
      meta.expires = Date.now() + PROFILE_TTL;
      meta.basketExpires = Date.now() + DAY;
      this.put("meta", meta);
      const selected = writing ? calculated!.trip : this.selectTrip(action);
      const response = this.view(action, meta, selected);
      response.newlyReachedThresholdsCents =
        calculated?.newlyReachedThresholdsCents ?? [];
      if (action.kind === "add_item" && action.shoppingListItemId) {
        response.consumedShoppingListItemId = action.shoppingListItemId;
        response.shoppingListRevision = meta.shoppingListRevision;
      }
      // Reads deduplicate activity only; do not retain another copy of the whole history.
      this.put(receiptKey, {
        fingerprint,
        ...(writing ? { result: response } : {}),
      });
      this.put(`replay/${receiptKey}`, { fingerprint, expires: meta.expires });
      return response;
    });
    await this.ctx.storage.setAlarm(this.deadline(this.get<Meta>("meta")!));
    return result;
  }
  private view(
    action: ThresholdAction,
    meta: Meta,
    selected: ThresholdTrip | null,
  ): Record<string, unknown> {
    const response: Record<string, unknown> = {
      basket: selected ? summarizeThresholds(selected) : null,
      revision: meta.revision,
      expiresAt: meta.basketExpires ?? null,
      profileExpiresAt: meta.expires,
      dataEpoch: meta.dataEpoch,
      ...(meta.lastBasketExpiredAt
        ? { lastBasketExpiredAt: meta.lastBasketExpiredAt }
        : {}),
      spaceId: meta.label,
      alreadyApplied: false,
      newlyReachedThresholdsCents: [],
    };
    if (action.kind === "list_trips")
      response.trips = this.rows<ThresholdTrip>("trip/").map(
        ({ value: t }) => ({
          id: t.id,
          store: t.store,
          createdAt: t.createdAt,
          currency: t.currency,
        }),
      );
    if (action.kind === "suggest_removals") {
      requireValue(selected, "trip_not_found", 404);
      response.removalSuggestion = suggestRemovals(selected, action);
    }
    return response;
  }
  private selectTrip(action: ThresholdAction) {
    if (action.kind === "start_trip") return null;
    const locator =
      "tripId" in action && action.tripId
        ? action.tripId
        : this.get<string>("current");
    const trip = locator
      ? this.get<ThresholdTrip>(`trip/${locator}`)
      : undefined;
    if ("tripId" in action && action.tripId)
      requireValue(trip, "trip_not_found", 404);
    return trip ?? null;
  }
  async deleteGuest(digest: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.exists()) return { deleted: true };
      this.ctx.storage.transactionSync(() => this.credential(digest, "access"));
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return { deleted: true };
    });
  }
  async clearBaskets(
    digest: string,
    expectedRevision: number,
    dataEpoch: string,
    operationId: string,
  ) {
    const fingerprint = await hash(canonical({ expectedRevision, dataEpoch }));
    const result = this.ctx.storage.transactionSync(() => {
      const { meta } = this.credential(digest, "access");
      const key = `control/${operationId}`;
      const prior = this.get<{
        fingerprint: string;
        result: Record<string, unknown>;
      }>(key);
      if (prior) {
        requireValue(
          prior.fingerprint === fingerprint,
          "operation_conflict",
          409,
        );
        return { ...prior.result, alreadyApplied: true };
      }
      requireValue(dataEpoch === meta.dataEpoch, "data_expired", 409);
      requireValue(
        expectedRevision === meta.revision,
        "revision_conflict",
        409,
      );
      this.pruneCredentials();
      requireValue(this.count("control/") < 1024, "guest_limit", 429);
      this.clearData(meta, false);
      meta.expires = Date.now() + PROFILE_TTL;
      this.put("meta", meta);
      const response = this.view({ kind: "get_basket" }, meta, null);
      this.put(key, { fingerprint, result: response, expires: meta.expires });
      return response;
    });
    await this.ctx.storage.setAlarm(this.deadline(this.get<Meta>("meta")!));
    return result;
  }
  async collect() {
    return this.ctx.blockConcurrencyWhile(async () => {
      let meta: Meta;
      try {
        meta = this.ctx.storage.transactionSync(() => {
          const active = this.active();
          this.pruneCredentials();
          return active;
        });
      } catch (e) {
        if (!(e instanceof Failure) || e.code !== "guest_expired") throw e;
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        return null;
      }
      const deadline = this.deadline(meta);
      await this.ctx.storage.setAlarm(deadline);
      return deadline;
    });
  }
  async alarm() {
    await this.collect();
  }
}

/** One bounded registry for app clients; contains no guest data or raw secrets. */
export class OAuthClients extends Documents {
  lookup(clientId: string): RegisteredClient | undefined {
    return this.get<RegisteredClient>(`client/${clientId}`);
  }
  private prune() {
    for (const prefix of ["request/"])
      for (const row of this.rows<{ expires: number }>(prefix))
        if (row.value.expires <= Date.now()) this.remove(row.key);
  }
  async register(input: {
    clientId: string;
    secretHash: string;
    metadata: ClientMetadata;
    requestHash?: string;
    fingerprint: string;
  }): Promise<RegisteredClient | { error: string; status: number }> {
    try {
      const result = this.ctx.storage.transactionSync(() => {
        this.install();
        this.prune();
        if (input.requestHash) {
          const old = this.get<{
            clientId: string;
            fingerprint: string;
            expires: number;
          }>(`request/${input.requestHash}`);
          if (old) {
            requireValue(
              old.fingerprint === input.fingerprint,
              "registration_conflict",
              409,
            );
            const client = this.lookup(old.clientId);
            requireValue(client, "invalid_client", 401);
            return client;
          }
        }
        const clients = this.rows<RegisteredClient>("client/");
        requireValue(
          clients.length < 256 &&
            clients.filter((c) => c.value.created > Date.now() - 3_600_000)
              .length < 32,
          "registration_rate_limited",
          429,
        );
        const client: RegisteredClient = {
          clientId: input.clientId,
          secretHash: input.secretHash,
          metadata: input.metadata,
          created: Date.now(),
        };
        this.put(`client/${client.clientId}`, client);
        if (input.requestHash)
          this.put(`request/${input.requestHash}`, {
            clientId: client.clientId,
            fingerprint: input.fingerprint,
            expires: Date.now() + DAY,
          });
        return client;
      });
      await this.arm();
      return result;
    } catch (e) {
      // RPC boundaries do not preserve our Error subclass/properties. Return
      // only deliberate public registration errors as structured data.
      if (e instanceof Failure) return { error: e.code, status: e.status };
      throw e;
    }
  }
  private async arm() {
    const receipts = this.rows<{ expires: number }>("request/");
    if (receipts.length)
      await this.ctx.storage.setAlarm(
        Math.min(...receipts.map((c) => c.value.expires)),
      );
    else await this.ctx.storage.deleteAlarm();
  }
  async collect() {
    // Serialize deletion with registration so GC cannot erase a new client.
    return this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => this.prune());
      if (this.count("client/") === 0) await this.ctx.storage.deleteAll();
      else await this.arm();
    });
  }
  async alarm() {
    await this.collect();
  }
}

export class AuthorizationFlow extends Documents {
  async initialize(flow: Flow) {
    requireValue(
      !this.exists() &&
        flow.expires > Date.now() &&
        flow.expires <= Date.now() + FLOW_TTL,
    );
    this.ctx.storage.transactionSync(() => {
      this.install();
      this.put("meta", flow);
    });
    await this.ctx.storage.setAlarm(flow.expires);
  }
  private verify(browser: string, csrf: string) {
    const flow = this.get<Flow>("meta");
    requireValue(
      flow &&
        flow.expires > Date.now() &&
        flow.browser === browser &&
        flow.csrf === csrf,
      "invalid_flow",
      403,
    );
    return flow;
  }
  async finish(
    flowId: string,
    browser: string,
    csrf: string,
    choice: "new" | "recover" | "deny",
    target?: { locator: string; recoveryHash: string },
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const flow = this.verify(browser, csrf);
      requireValue(
        !flow.decision ||
          (flow.decision === choice &&
            (choice !== "recover" ||
              (flow.vault === target?.locator &&
                flow.recoveryHash === target.recoveryHash))),
        "flow_conflict",
        409,
      );
      if (!flow.decision) {
        flow.decision = choice;
        if (choice === "recover") {
          requireValue(target);
          flow.vault = target.locator;
          flow.recoveryHash = target.recoveryHash;
        }
        this.put("meta", flow);
      }
      if (choice === "deny") {
        flow.confirmed = true;
        this.put("meta", flow);
        return { denied: true as const, authorization: flow.authorization };
      }
      const issued = await issuance(this.env, flowId, flow.vault);
      if (!flow.confirmed) {
        if (choice === "new") {
          requireValue(
            this.env.ENROLLMENT_ENABLED === "true",
            "enrollment_disabled",
            503,
          );
          await track(this.env, "vault", flow.vault, Date.now() + DAY);
          await this.env.VAULTS.getByName(flow.vault).authorize({
            flow: flowId,
            locator: flow.vault,
            deadline: flow.expires,
            authorization: flow.authorization,
            codeHash: await hash(issued.code),
            recoveryHash: await hash(issued.recovery),
          });
        } else {
          // Preparing recovery is read-only in the vault. Abandoning this page
          // or losing its response must leave every old credential untouched.
          requireValue(flow.recoveryHash);
          await this.env.VAULTS.getByName(flow.vault).checkRecovery(
            flow.recoveryHash,
          );
        }
        flow.confirmed = true;
        this.put("meta", flow);
      }
      return {
        denied: false as const,
        ...issued,
        authorization: flow.authorization,
      };
    });
  }
  async continuation(flowId: string, browser: string, csrf: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const flow = this.verify(browser, csrf);
      requireValue(flow.confirmed && flow.decision !== "deny");
      const issued = await issuance(this.env, flowId, flow.vault);
      const vault = this.env.VAULTS.getByName(flow.vault);
      if (flow.decision === "recover") {
        requireValue(flow.recoveryHash);
        // Revalidate the old key inside the same vault transaction that revokes
        // grants, rotates recovery, records issuance, and activates the code.
        await vault.authorize({
          flow: flowId,
          locator: flow.vault,
          deadline: flow.expires,
          authorization: flow.authorization,
          codeHash: await hash(issued.code),
          recoveryHash: await hash(issued.recovery),
          previousRecovery: flow.recoveryHash,
        });
      } else {
        await vault.activateCode(await hash(issued.code));
      }
      return { authorization: flow.authorization, code: issued.code };
    });
  }
  async collect() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const flow = this.get<Flow>("meta");
      if (!flow || flow.expires <= Date.now()) {
        await this.ctx.storage.deleteAll();
        return null;
      }
      await this.ctx.storage.setAlarm(flow.expires);
      return flow.expires;
    });
  }
  async alarm() {
    await this.collect();
  }
}

interface Entry {
  kind: "vault" | "flow";
  locator: string;
  deadline: number;
}
export class CleanupIndex extends Documents {
  track(kind: Entry["kind"], locator: string, deadline: number) {
    this.ctx.storage.transactionSync(() => {
      this.install();
      requireValue(
        this.count("entry/") < 10000 || this.get(`entry/${kind}/${locator}`),
        "capacity_exceeded",
        503,
      );
      this.put(`entry/${kind}/${locator}`, { kind, locator, deadline });
    });
  }
  async sweep() {
    // Keep entries until cleanup succeeds. Crashes/retries only repeat an idempotent collect.
    const due = this.rows<Entry>("entry/")
      .filter((r) => r.value.deadline <= Date.now())
      .sort((a, b) => a.value.deadline - b.value.deadline)
      .slice(0, 100);
    for (const { key, value } of due) {
      try {
        const next = await (
          value.kind === "vault"
            ? this.env.VAULTS.getByName(value.locator)
            : this.env.FLOWS.getByName(value.locator)
        ).collect();
        this.ctx.storage.transactionSync(() => {
          if (next === null) this.remove(key);
          else this.put(key, { ...value, deadline: next });
        });
      } catch {
        // Back off failed entries so a poisoned oldest batch cannot starve all later cleanup.
        this.put(key, { ...value, deadline: Date.now() + 15 * 60_000 });
      }
    }
    // Do not deleteAll here: a concurrent track could otherwise lose its new entry.
    return { checked: due.length, remaining: this.rows("entry/").length };
  }
}
