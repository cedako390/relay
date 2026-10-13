import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ORCH_BACKEND / VITE_PORT are set by the desktop dev supervisor (packages/desktop/scripts/dev.mjs).
const BACKEND = process.env.ORCH_BACKEND ?? 'http://127.0.0.1:4180';
const PORT = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    proxy: {
      // changeOrigin rewrites Host to the backend's, which the server requires (loopback only).
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    // xterm + router + Radix land in one ~1 MB chunk; fine for a local tool.
    chunkSizeWarningLimit: 1200,
    sourcemap: true,
  },
});
