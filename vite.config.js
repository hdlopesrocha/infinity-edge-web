import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// InfinityEdge Web — Vue 3 + three.js (WebGL)
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
})
