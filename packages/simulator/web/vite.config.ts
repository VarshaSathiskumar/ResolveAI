import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { PORTS, simBackendUrl, LOCAL_HOST } from '../../../config.js';
import { withoutSandbox } from './vite-plugins';

// The browser only ever talks to this dev server; /api is passed through to the simulator backend.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), withoutSandbox()],
  server: {
    host: LOCAL_HOST,
    port: PORTS.web,
    strictPort: true,
    proxy: { '/api': { target: simBackendUrl(), changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
