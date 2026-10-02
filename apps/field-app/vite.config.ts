import { defineConfig } from "vite";

export default defineConfig({
  base: "/field/",
  // Two pages: the scan and hand-off screens, and the damaged-label video call.
  build: { outDir: "../control-room/dist/field", emptyOutDir: true, rollupOptions: { input: { main: "index.html", call: "call.html" } } },
  server: { proxy: { "/api": { target: process.env["LEDGER_URL"] ?? "http://localhost:8081", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } } },
});
