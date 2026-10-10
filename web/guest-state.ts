import {
  emptyGuestState,
  guestView,
  parseGuestState,
  type GuestResult,
  type GuestState,
} from "../src/guest.js";

export interface WidgetStorage {
  widgetState?: unknown;
  setWidgetState?: (value: unknown) => void | Promise<void>;
}
export type GuestTransport = (
  state: GuestState,
  action: Record<string, unknown>,
) => Promise<GuestResult>;

/** State is per widget, not localStorage, a shared cookie, or a server-side session. */
export class GuestSession {
  state = emptyGuestState();
  storageWarning = "";
  private persistence: Promise<void> = Promise.resolve();
  constructor(private readonly storage: () => WidgetStorage | undefined) {}

  restore(): boolean {
    const value = this.storage()?.widgetState;
    if (value === undefined || value === null) return false;
    try {
      const raw = value as { basketWiseGuest?: unknown };
      const restored = parseGuestState(raw.basketWiseGuest);
      if (restored.revision < this.state.revision) return false;
      if (
        restored.revision === this.state.revision &&
        JSON.stringify(restored) !== JSON.stringify(this.state)
      ) {
        this.storageWarning =
          "A conflicting widget snapshot was ignored. Your current basket is unchanged.";
        return false;
      }
      this.state = restored;
      return true;
    } catch {
      this.storageWarning =
        "The saved widget snapshot could not be read. It has not been overwritten; start a new shop only if you want to replace it.";
      return false;
    }
  }

  async accept(
    value: unknown,
    expectedRevision?: number,
  ): Promise<GuestResult> {
    const result = value as GuestResult;
    const state = parseGuestState(result.state);
    if (
      expectedRevision !== undefined &&
      this.state.revision !== expectedRevision &&
      JSON.stringify(state) !== JSON.stringify(this.state)
    )
      throw new Error(
        "The basket changed while this request was running. Review the current basket and retry.",
      );
    if (
      state.revision < this.state.revision ||
      (state.revision === this.state.revision &&
        JSON.stringify(state) !== JSON.stringify(this.state))
    )
      throw new Error(
        "An older or conflicting basket response was ignored. Your current basket is unchanged.",
      );
    if (JSON.stringify(state) === JSON.stringify(this.state))
      return {
        ...result,
        ...guestView(state),
        alreadyApplied: result.alreadyApplied ?? false,
      };
    this.state = state;
    // Serialize host writes so a slow older save cannot finish after a newer one.
    this.persistence = this.persistence.then(async () => {
      if (state.revision < this.state.revision) return;
      try {
        const bridge = this.storage();
        if (!bridge?.setWidgetState)
          throw new Error("Widget storage unavailable");
        await bridge.setWidgetState({ basketWiseGuest: state });
        this.storageWarning = "";
      } catch {
        this.storageWarning =
          "Widget storage is unavailable. This basket is only in memory and may disappear when this view closes.";
      }
    });
    await this.persistence;
    // Recalculate derived values; never trust totals supplied in an incoming UI message.
    return {
      ...result,
      ...guestView(state),
      newlyReachedThresholdsCents: result.newlyReachedThresholdsCents ?? [],
      alreadyApplied: result.alreadyApplied ?? false,
    };
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    transport: GuestTransport,
  ): Promise<GuestResult> {
    const revision = this.state.revision;
    const result = await transport(structuredClone(this.state), {
      ...args,
      kind: name,
    });
    return this.accept(result, revision);
  }
}
