import type {
  ThresholdBasket,
  ThresholdConfig,
  suggestRemovals,
} from "./thresholds.js";

export interface BasketSnapshot {
  revision: number;
  spaceId: string;
  expiresAt?: number | null;
  profileExpiresAt?: number;
  dataEpoch: string;
  lastBasketExpiredAt?: number;
  basket?: ThresholdBasket | null;
  removalSuggestion?: ReturnType<typeof suggestRemovals>;
}
export interface Result {
  isError?: boolean | undefined;
  structuredContent?: unknown;
  _meta?: Record<string, unknown> | undefined;
}
export interface Bridge {
  callServerTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Result>;
}
interface Pending {
  action: Record<string, unknown>;
  expectedRevision?: number;
  activityId?: string;
  dataEpoch?: string;
}
export class BasketController {
  revision: number | undefined;
  tripId: string | undefined;
  spaceId: string | undefined;
  busy = false;
  authorizationRequired = false;
  snapshot: BasketSnapshot | undefined;
  private pending: Pending | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private discard() {
    this.revision = undefined;
    this.tripId = undefined;
    this.snapshot = undefined;
    this.pending = undefined;
    clearTimeout(this.expiryTimer);
  }
  private fresh() {
    if (
      this.snapshot?.expiresAt != null &&
      this.snapshot.expiresAt <= Date.now()
    ) {
      this.discard();
      this.show(
        "Your previous baskets expired. Load your connected space to start fresh.",
      );
      this.changed();
    }
    return this.snapshot !== undefined;
  }
  get hasPending() {
    return this.pending !== undefined;
  }
  constructor(
    private bridge: Bridge,
    private show: (text: string) => void,
    private newId: () => string = () => crypto.randomUUID(),
    private changed: () => void = () => {},
  ) {}
  accept(result: Result) {
    const data = result.structuredContent as
      | (Partial<BasketSnapshot> & {
          error?: string;
          revision?: number;
          spaceId?: string;
          deleted?: boolean;
        })
      | undefined;
    if (result.isError) {
      if (result._meta?.["mcp/www_authenticate"]) {
        this.discard();
        this.authorizationRequired = true;
        this.show(
          "Connect through the host's OAuth flow, then retry. Never paste credentials here.",
        );
      } else if (
        [
          "revision_conflict",
          "data_expired",
          "operation_conflict",
          "trip_not_found",
          "invalid_request",
          "guest_limit",
        ].includes(data?.error ?? "")
      ) {
        this.discard();
        this.show(
          "The request was rejected. Load the latest basket and reconcile the change; it will not be retried automatically.",
        );
      } else
        this.show(
          "The outcome is uncertain. Retry preserves the original operation ID.",
        );
      this.changed();
      return false;
    }
    if (
      typeof data?.revision === "number" &&
      typeof data.spaceId === "string"
    ) {
      if (
        data.spaceId === this.spaceId &&
        this.revision !== undefined &&
        data.revision < this.revision
      )
        return true;
      if (
        typeof data.dataEpoch !== "string" ||
        (data.expiresAt != null && data.expiresAt <= Date.now())
      ) {
        this.discard();
        this.show(
          "This saved basket is out of date. Load your connected space to start fresh.",
        );
        this.changed();
        return true;
      }
      this.spaceId = data.spaceId;
      this.authorizationRequired = false;
      this.revision = data.revision;
      this.tripId = data.basket?.id;
      this.snapshot = data as BasketSnapshot;
      clearTimeout(this.expiryTimer);
      if (data.expiresAt != null) {
        this.expiryTimer = setTimeout(
          () => {
            this.fresh();
          },
          Math.min(data.expiresAt - Date.now() + 1, 2_147_483_647),
        );
        // Do not keep test or server processes alive for a UI-only timer.
        (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
      }
      this.show("");
      this.changed();
      return true;
    }
    if (data?.deleted) {
      this.discard();
      this.authorizationRequired = true;
      this.spaceId = undefined;
      this.pending = undefined;
      this.snapshot = undefined;
      this.show(
        "Guest data deleted. Old credentials and recovery keys no longer work.",
      );
      this.changed();
      return true;
    }
    return false;
  }
  private async run(input: Pending) {
    if (this.busy) return;
    if (input.expectedRevision !== undefined && !this.fresh()) return;
    this.pending = input;
    this.busy = true;
    this.changed();
    try {
      const { kind, ...parameters } = input.action;
      if (
        this.accept(
          await this.bridge.callServerTool({
            name: String(kind),
            arguments: {
              ...parameters,
              ...(input.activityId ? { activityId: input.activityId } : {}),
              ...(input.dataEpoch ? { dataEpoch: input.dataEpoch } : {}),
              ...(input.expectedRevision === undefined
                ? {}
                : { expectedRevision: input.expectedRevision }),
            },
          }),
        )
      )
        this.pending = undefined;
    } catch {
      this.show(
        "Host call did not complete. Retry the same action; its operation ID is preserved.",
      );
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async load() {
    this.fresh();
    await this.run(
      this.pending ?? {
        action: { kind: "get_basket" },
        activityId: this.newId(),
      },
    );
  }
  async start() {
    this.fresh();
    if (this.pending) return this.run(this.pending);
    if (this.revision === undefined) {
      this.show("Load your guest space first.");
      return;
    }
    await this.run({
      action: {
        kind: "start_trip",
        operationId: this.newId(),
        currency: "EUR",
      },
      expectedRevision: this.revision,
      dataEpoch: this.snapshot!.dataEpoch,
    });
  }
  async add(name: string, unitPriceCents: number) {
    this.fresh();
    if (this.pending) return this.run(this.pending);
    if (!this.tripId || this.revision === undefined) {
      this.show("Load or start a trip first.");
      return;
    }
    await this.run({
      action: {
        kind: "add_item",
        operationId: this.newId(),
        tripId: this.tripId,
        name,
        unitPriceCents,
      },
      expectedRevision: this.revision,
      dataEpoch: this.snapshot!.dataEpoch,
    });
  }
  async setThresholds(thresholdConfig: ThresholdConfig) {
    this.fresh();
    if (this.pending) return this.run(this.pending);
    if (!this.tripId || this.revision === undefined) return;
    await this.run({
      action: {
        kind: "set_thresholds",
        tripId: this.tripId,
        thresholdConfig,
        operationId: this.newId(),
      },
      expectedRevision: this.revision,
      dataEpoch: this.snapshot!.dataEpoch,
    });
  }
  async suggestRemovals() {
    this.fresh();
    if (this.pending) return this.run(this.pending);
    if (!this.tripId || this.revision === undefined) return;
    await this.run({
      action: { kind: "suggest_removals", tripId: this.tripId },
      activityId: this.newId(),
    });
  }
  async clearConfirmed() {
    if (!this.fresh() || this.revision === undefined) return;
    await this.run(
      this.pending ?? {
        action: {
          kind: "clear_baskets",
          confirm: true,
          operationId: this.newId(),
        },
        expectedRevision: this.revision,
        dataEpoch: this.snapshot!.dataEpoch,
      },
    );
  }
  async deleteConfirmed() {
    if (this.busy) return;
    this.busy = true;
    this.changed();
    try {
      this.accept(
        await this.bridge.callServerTool({
          name: "delete_guest",
          arguments: { confirm: true },
        }),
      );
    } catch {
      this.show(
        "Deletion response unavailable. Retry to check; never create a replacement automatically.",
      );
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
