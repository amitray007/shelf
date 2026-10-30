import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    manifest: true,
    // The chunks above the default 500 kB limit are Shiki grammars and its
    // WASM engine, all loaded on demand by the source viewer.
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // Entry-aware names contain '~'; keep asset names compatible with API preloads.
        chunkFileNames: (chunk) => {
          const group = chunk.name.split('~')[0];
          return group === 'icons' || group === 'ui'
            ? `assets/${group}-[hash].js`
            : 'assets/[name]-[hash].js';
        },
        codeSplitting: {
          groups: [
            // Claim the existing entry graph first so the groups below cannot
            // make boot code depend on every icon or UI primitive.
            { name: 'app', tags: ['$initial'] },
            {
              name: 'icons',
              test: /node_modules[\\/]@phosphor-icons[\\/]react[\\/]/,
              minShareCount: 2,
              // Merge small shared groups without loading every feature's icons.
              entriesAware: true,
              entriesAwareMergeThreshold: 50_000,
            },
            {
              name: 'ui',
              test: /node_modules[\\/](?:@cloudflare[\\/]kumo|@base-ui[\\/](?:react|utils))[\\/]/,
              minShareCount: 2,
              entriesAware: true,
              entriesAwareMergeThreshold: 50_000,
            },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
