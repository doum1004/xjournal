import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `bun run web:dev` serves the UI on :5173 and proxies the API to the hub on :7420.
// `bun run web:build` writes apps/web/dist, which the hub serves at / (apps/server/src/app.ts).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:7420' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
