import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/star-voting/',
  build: {
    // The app is one function among several planned for choicelab.app, so it
    // lives under /star-voting/ rather than the domain root — see
    // site-root/ for what's served at the root itself.
    outDir: 'dist/star-voting',
  },
  plugins: [react()],
})
