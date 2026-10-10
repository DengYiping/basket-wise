import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  build: { command: "npm run build --prefix .." },
  sendMetrics: false,
  uploadSourceMaps: false,
  types: { generate: false },
});
