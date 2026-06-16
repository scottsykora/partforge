import { defineConfig } from "vite";

// Replicad ships OpenCASCADE as a large WASM module. Keep Vite from trying to
// pre-bundle it, and build workers as ES modules so they can `import` replicad.
export default defineConfig({
  optimizeDeps: {
    exclude: ["replicad", "replicad-opencascadejs"],
  },
  worker: {
    format: "es",
  },
});
