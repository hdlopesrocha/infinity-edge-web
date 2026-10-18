import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// HTTPS with the self-signed dev certificate when it exists (run
// `npm run dev:https`, which generates certs/dev.{crt,key} first). Motion and
// VR features need a secure context, and a phone can only reach this machine
// over the network with TLS.
const here = dirname(fileURLToPath(import.meta.url))
const certFile = join(here, 'certs', 'dev.crt')
const keyFile = join(here, 'certs', 'dev.key')
const https = existsSync(certFile) && existsSync(keyFile)
  ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
  : undefined

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    https,
    // The game server speaks plain ws:// and the dev page is https://, which
    // blocks it as mixed content: tunnel it through Vite instead. Point the
    // client at it with `?game=/game` (or `?game=wss://<host>:5173/game`).
    // IE_GAME_PROXY overrides the backend, e.g. ws://127.0.0.1:8095.
    proxy: {
      '/game': {
        target: process.env.IE_GAME_PROXY || 'ws://127.0.0.1:8091',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
})
