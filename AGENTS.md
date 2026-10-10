# Basket Wise development

- This is a private, local-first ChatGPT MCP plugin, not a deployed service.
- Run `npm run check` after changes. HTTP tests need ephemeral loopback binding.
- Preserve integer-cent money arithmetic and one half-up rounding per line.
- All mutations require persistent idempotency and atomic SQLite transactions.
- Never infer Dunnes voucher rules from a personal spending milestone.
- Never save a photo-derived expiry date without user confirmation of the full
  date, including its year. Keep use-by and best-before distinct.
- Do not add a model API call, photo storage, telemetry, or remote service without
  explicit user approval. Image understanding belongs to the ChatGPT host.
- Keep database files, credentials, dependencies, and generated builds out of Git.
- The browser preview is isolated sample data; do not represent it as persisted.
- Do not expose the single-user store publicly without authentication and
  per-user data isolation. The development bearer token is not production OAuth.
- Update plugin and package versions together; keep the MCP app self-contained.
