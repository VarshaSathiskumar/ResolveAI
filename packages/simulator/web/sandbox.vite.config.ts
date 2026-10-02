import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { sandboxServer } from './vite-plugins';

// The second origin: same files, its own port, only ever asked for sandbox.html.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), sandboxServer()],
  server: { host: '127.0.0.1', port: Number(process.env.VITE_SANDBOX_PORT ?? 5174), strictPort: true, cors: false },
});
