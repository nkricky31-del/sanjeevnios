import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Stamp the service worker with this build's id so every deploy ships a changed
// sw.js. Phones then pick up the new app on their next open instead of staying
// on a stale cached copy.
function stampServiceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(c) {
      outDir = join(c.root, c.build.outDir)
    },
    closeBundle() {
      const file = join(outDir, 'sw.js')
      try {
        const id = Date.now().toString(36)
        writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD_ID__', id))
      } catch {
        /* no sw.js in the output */
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
})
