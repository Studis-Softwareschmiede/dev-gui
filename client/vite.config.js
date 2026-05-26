import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the dev-gui frontend.
 *
 * Build output → client/dist  (served by Express in item #13)
 * Dev proxy: /ws and /api forwarded to backend on :8080
 */
export default defineConfig({
  plugins: [react()],
  root: '.',          // index.html lives in client/
  build: {
    outDir: 'dist',   // relative to root → client/dist
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target:  'ws://localhost:8080',
        ws:      true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
