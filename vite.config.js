import { defineConfig } from "vite";

// Replicad ships OpenCASCADE as a large WASM module. Keep Vite from trying to
// pre-bundle it, and build workers as ES modules so they can `import` replicad.
export default defineConfig({
  // Served from https://scottsykora.github.io/Drum-Machine/ on GitHub Pages.
  // Use a relative base in production so asset URLs resolve under the repo
  // subpath; "/" locally for `vite dev`.
  base: process.env.GITHUB_ACTIONS ? "/Drum-Machine/" : "/",
  optimizeDeps: {
    exclude: ["replicad", "replicad-opencascadejs"],
  },
  worker: {
    format: "es",
  },
});
