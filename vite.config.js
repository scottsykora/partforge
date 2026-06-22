import { defineConfig } from "vite";

// partforge dev harness: `npm run dev` serves /demo.html (the example part), and
// `npm run build` builds it as a sanity check. The published package is plain ESM
// source — this config is only for developing/testing the framework itself.
// Replicad ships OpenCASCADE as a large WASM module; keep Vite from pre-bundling it,
// and build workers as ES modules so they can import replicad.
export default defineConfig({
  optimizeDeps: {
    exclude: ["replicad", "replicad-opencascadejs"],
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: { input: "demo.html" },
  },
});
