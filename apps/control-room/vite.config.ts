import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying keeps the browser same-origin, so the dashboard needs no CORS
    // grant and the API needs no knowledge of where the UI is served from.
    proxy: {
      "/api": {
        target: process.env["LEDGER_URL"] ?? "http://localhost:8081",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
