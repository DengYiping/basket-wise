// Minimal structural runtime types; workerd integration tests exercise the real APIs.
declare module "cloudflare:workers" {
  export class DurableObject<E = unknown> {
    protected ctx: import("./types.js").State;
    protected env: E;
    constructor(ctx: import("./types.js").State, env: E);
  }
}
