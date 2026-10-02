import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { withoutSandbox } from './vite-plugins';

// The browser only ever talks to this dev server; /api is passed through to the simulator backend.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), withoutSandbox()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.SIM_BACKEND ?? 'http://127.0.0.1:3200', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
