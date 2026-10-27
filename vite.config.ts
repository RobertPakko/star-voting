import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Served from the root of choicelab.app.
  base: '/',
  plugins: [react()],
  server: {
    // The intro recording's browser profile (scripts/intro/browser.mjs) holds
    // files open, and watching one while the browser runs crashes the server.
    watch: { ignored: ['**/.capture-profile/**'] },
  },
})
