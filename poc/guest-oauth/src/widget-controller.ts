export interface ProbeResult {
  isError?: boolean | undefined;
  _meta?: Record<string, unknown> | undefined;
  structuredContent?: unknown;
}

export interface ProbeBridge {
  callServerTool(input: {
    name: string;
    arguments: Record<string, never>;
  }): Promise<ProbeResult>;
}

/** No credential fields, direct HTTP requests, widget state, or browser storage. */
export class ProbeController {
  busy = false;
  constructor(
    private readonly bridge: ProbeBridge,
    private readonly show: (message: string) => void,
  ) {}

  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.show("Checking through the host’s MCP connection…");
    try {
      const result = await this.bridge.callServerTool({
        name: "guest_probe",
        arguments: {},
      });
      if (result.isError) {
        this.show(
          result._meta?.["mcp/www_authenticate"]
            ? "Authorization is required. Complete the host’s connection flow, then click again. Automatic retry is not assumed."
            : "The probe failed. No identity was verified.",
        );
        return;
      }
      const value = result.structuredContent;
      const data =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : undefined;
      if (
        typeof data?.guestTag !== "string" ||
        typeof data.requestId !== "string"
      ) {
        this.show(
          "No valid probe response was received. No identity was verified.",
        );
        return;
      }
      this.show(
        `Verified by the PoC server\nGuest: ${data.guestTag}\nRequest: ${data.requestId}\nCompare this guest tag with a chat-driven guest_probe result.`,
      );
    } catch {
      // Never display arbitrary transport errors that could contain credentials.
      this.show(
        "The host call did not complete. Connect or retry; no identity was verified.",
      );
    } finally {
      this.busy = false;
    }
  }
}
