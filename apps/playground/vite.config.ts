import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    allowedHosts: [".ts.net"],
  },
  preview: {
    host: "127.0.0.1",
    port: 5180,
    allowedHosts: [".ts.net"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ["loro-crdt"],
  },
});
