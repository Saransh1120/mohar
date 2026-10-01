import { defineConfig } from "vite";

export default defineConfig({
  base: "/field/",
  build: { outDir: "../control-room/dist/field", emptyOutDir: true },
  server: { proxy: { "/api": { target: process.env["LEDGER_URL"] ?? "http://localhost:8081", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } } },
});
