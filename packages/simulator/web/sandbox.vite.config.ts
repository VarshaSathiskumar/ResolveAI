import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { LOCAL_HOST, sandboxPort } from '../../../config.js';
import { sandboxServer } from './vite-plugins';

// The second origin: same files, its own port, only ever asked for sandbox.html.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), sandboxServer()],
  server: { host: LOCAL_HOST, port: sandboxPort(), strictPort: true, cors: false },
});
