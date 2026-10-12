import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// InfinityEdge Web — Vue 3 + TypeScript + raw WebGL2 (no game engine).
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
