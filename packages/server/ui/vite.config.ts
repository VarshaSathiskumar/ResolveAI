import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Bundles the ticket card view into one self-contained HTML file: the host shows it in a sandboxed iframe with no
// network access, so everything it needs (scripts, styles) has to be inline.
const root = resolve(import.meta.dirname, 'ticket-card');

export default defineConfig({
  root,
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, '../dist/ui'),
    emptyOutDir: false,
    rollupOptions: { input: resolve(root, 'ticket-card.html') },
  },
});
