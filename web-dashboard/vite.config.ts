import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// §1.9.2 performance budget: code-split by route; map lazy-loaded; API gzipped via gateway.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2018',           // low-end Android browsers via WebView fallbacks
    chunkSizeWarningLimit: 600,
    rollupOptions: { output: { manualChunks: { leaflet: ['leaflet', 'react-leaflet'] } } },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/tiles': 'http://localhost:8082' },
  },
});
