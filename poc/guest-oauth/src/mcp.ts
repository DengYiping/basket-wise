import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { SCOPE, VERSION, type Config } from "./config.js";
import type { GuestAuthStore } from "./store.js";

export const WIDGET_URI = "ui://guest-oauth-poc/probe.html";

export function challenge(config: Config, invalid = false): string {
  return `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ""}`;
}

export function createProbeServer(
  store: GuestAuthStore,
  widgetHtml: string,
  accessToken?: string,
): McpServer {
  const server = new McpServer(
    { name: "guest-oauth-poc", version: VERSION },
    {
      instructions:
        "Isolated synthetic OAuth probe, not Basket Wise. Use open_guest_probe for the widget and guest_probe for a server-verified identity. Never request or put credentials in tool arguments. Guest tags are not credentials. Real ChatGPT compatibility remains unverified until tested in that host.",
    },
  );
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const ui = {
    resourceUri: WIDGET_URI,
    visibility: ["model", "app"] as ("model" | "app")[],
  };
  const definitions = [
    {
      name: "open_guest_probe",
      title: "Open guest OAuth probe",
      description:
        "Open the public synthetic identity probe widget. Opening it does not authenticate a guest.",
      schemes: [{ type: "noauth" }],
    },
    {
      name: "guest_probe",
      title: "Check guest identity",
      description:
        "Return the temporary guest identity verified from the OAuth bearer token. Takes no identity or token arguments; no shopping data is read or changed.",
      schemes: [{ type: "oauth2", scopes: [SCOPE] }],
    },
  ];
  for (const definition of definitions) {
    registerAppTool(
      server,
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: z.strictObject({}),
        annotations,
        _meta: {
          ui,
          securitySchemes: definition.schemes,
          "openai/widgetAccessible": true,
        },
      },
      async (): Promise<CallToolResult> => {
        if (definition.name === "open_guest_probe")
          return {
            content: [
              {
                type: "text",
                text: "Guest OAuth probe opened. No authorization result yet; use the button or guest_probe.",
              },
            ],
            structuredContent: {
              purpose:
                "Synthetic guest OAuth compatibility check; not a saved basket.",
            },
          };
        const identity = accessToken
          ? store.authenticate(accessToken)
          : undefined;
        if (!identity)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Guest authorization required. Connect through OAuth; never paste a token into chat.",
              },
            ],
            _meta: {
              "mcp/www_authenticate": [
                challenge(store.config, Boolean(accessToken)),
              ],
            },
          };
        const result = { ...identity, requestId: randomUUID() };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
  }
  // This installed MCP SDK has no top-level securitySchemes config field.
  // Publish standard tool descriptors with that field plus the compatibility mirror.
  server.server.setRequestHandler("tools/list", async () => ({
    tools: definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
      annotations,
      securitySchemes: definition.schemes,
      _meta: {
        ui,
        securitySchemes: definition.schemes,
        "openai/widgetAccessible": true,
      },
    })),
  }));
  const resourceUi = {
    prefersBorder: true,
    csp: { connectDomains: [], resourceDomains: [] },
  };
  registerAppResource(
    server,
    "Guest OAuth probe",
    WIDGET_URI,
    { _meta: { ui: resourceUi } },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: { ui: resourceUi },
        },
      ],
    }),
  );
  return server;
}
