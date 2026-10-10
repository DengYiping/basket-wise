import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createGuestServer } from "./guest-server.js";
import { MAX_GUEST_REQUEST_BYTES } from "./guest.js";

export interface GuestWorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GUEST_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

/** Deliberately imports neither the SQLite store nor the private HTTP server. */
export default {
  async fetch(request: Request, env: GuestWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    const origin = request.headers.get("origin");
    const allowedOrigins = [
      url.origin,
      "https://chatgpt.com",
      "https://chat.openai.com",
    ];
    if (origin && !allowedOrigins.includes(origin))
      return new Response("Origin not allowed.", { status: 403, headers });
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, MCP-Protocol-Version, MCP-Session-Id",
      );
      headers.set("Access-Control-Expose-Headers", "MCP-Protocol-Version");
    }
    if (url.pathname === "/health")
      return Response.json(
        { status: "ok", mode: "guest", persistence: "widget-only" },
        { headers },
      );
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", { status: 405, headers });
      const asset = await env.ASSETS.fetch(request);
      return new Response(asset.body, {
        status: asset.status,
        headers: new Headers([...asset.headers, ...headers]),
      });
    }
    if (url.pathname !== "/mcp")
      return new Response("Not found", { status: 404, headers });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return new Response("This stateless MCP endpoint accepts POST only.", {
        status: 405,
        headers,
      });
    }
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return new Response("Expected application/json", {
        status: 415,
        headers,
      });
    if (Number(request.headers.get("content-length")) > MAX_GUEST_REQUEST_BYTES)
      return new Response("Request too large", { status: 413, headers });
    if (env.GUEST_RATE_LIMITER) {
      // Cloudflare supplies this header. The key is used only for short-lived abuse limiting.
      const { success } = await env.GUEST_RATE_LIMITER.limit({
        key: request.headers.get("CF-Connecting-IP") ?? "unknown",
      });
      if (!success) {
        headers.set("Retry-After", "60");
        return new Response("Too many requests", { status: 429, headers });
      }
    } else if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return new Response("Guest rate limiter is not configured.", {
        status: 503,
        headers,
      });
    }
    const server = createGuestServer(async () => {
      const response = await env.ASSETS.fetch(
        new Request(new URL("/index.html", url)),
      );
      if (!response.ok) throw new Error("Guest widget asset is unavailable.");
      return response.text();
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_GUEST_REQUEST_BYTES,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // Buffer this bounded, JSON-only response before closing its request-scoped server.
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, {
        status: response.status,
        headers: new Headers([...response.headers, ...headers]),
      });
    } catch {
      // Never log request bodies, tool arguments, labels or basket snapshots.
      return Response.json(
        {
          error:
            "Guest calculation unavailable. Retry with the same operation ID.",
        },
        { status: 500, headers },
      );
    } finally {
      await server.close();
    }
  },
};
