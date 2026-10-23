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
    proxy: {
      // Backend mounts routes WITHOUT the /api prefix (/healthz, /auth/login,
      // /geofences, ...). nginx does the same in prod: `location /api/ ->
      // proxy_pass http://api:3000/;` strips the prefix. Mirror that here so
      // dev traffic `/api/geofences` reaches `/geofences` instead of 404ing.
      '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/tiles': 'http://localhost:8082',
    },
  },
});
