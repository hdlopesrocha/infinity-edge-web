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
  server: { host: true, port: 5173, strictPort: true, https },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
})
