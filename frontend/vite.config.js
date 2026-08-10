import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Dev only. src/config.js resolves API_BASE to "" when VITE_API_URL is unset,
  // so the app calls /api/... same-origin. Without this proxy those requests hit
  // the Vite dev server, which has no backend — every call 404s and the login
  // POST silently fails. Proxying keeps it same-origin (no CORS) and points at
  // the local FastAPI. Does not affect `vite build` or production in any way.
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target:
          globalThis.process?.env?.VITE_API_PROXY_TARGET ||
          "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  preview: { port: 3000 },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) {
            return 'recharts';
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react-vendor';
          }
        },
      },
    },
  },
})
