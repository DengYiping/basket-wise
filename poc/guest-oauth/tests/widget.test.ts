import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProbeController, type ProbeResult } from "../src/widget-controller.js";

describe("credential-free widget controller (mock host, not ChatGPT proof)", () => {
  it("uses only the host tool bridge with empty arguments", async () => {
    let input: unknown,
      output = "";
    const controller = new ProbeController(
      {
        callServerTool: async (value) => {
          input = value;
          return {
            structuredContent: {
              guestTag: "guest-test",
              requestId: "request-test",
            },
          };
        },
      },
      (message) => {
        output = message;
      },
    );
    await controller.check();
    assert.deepEqual(input, { name: "guest_probe", arguments: {} });
    assert.match(output, /guest-test/);
    assert.match(output, /request-test/);
    assert.equal(controller.busy, false);
  });

  it("does not turn auth challenges, malformed results or transport failures into success", async () => {
    for (const response of [
      { isError: true, _meta: { "mcp/www_authenticate": ["Bearer"] } },
      { isError: true },
      {},
      { structuredContent: { guestTag: "missing-request" } },
    ] satisfies ProbeResult[]) {
      let output = "";
      const controller = new ProbeController(
        { callServerTool: async () => response },
        (message) => {
          output = message;
        },
      );
      await controller.check();
      assert.ok(!output.startsWith("Verified"));
      assert.equal(controller.busy, false);
    }
    let output = "";
    const controller = new ProbeController(
      {
        callServerTool: async () => {
          throw new Error("secret-token-must-not-be-shown");
        },
      },
      (message) => {
        output = message;
      },
    );
    await controller.check();
    assert.ok(!output.includes("secret-token"));
    assert.equal(controller.busy, false);
  });

  it("deduplicates overlapping button clicks without replaying or storing credentials", async () => {
    let count = 0,
      finish: (value: ProbeResult) => void = () => {};
    const controller = new ProbeController(
      {
        callServerTool: async () => {
          count++;
          return new Promise<ProbeResult>((resolve) => {
            finish = resolve;
          });
        },
      },
      () => {},
    );
    const first = controller.check();
    await controller.check();
    assert.equal(count, 1);
    finish({ structuredContent: { guestTag: "guest", requestId: "request" } });
    await first;
    assert.equal(controller.busy, false);
  });
});
