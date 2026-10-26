import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Served from the root of choicelab.app.
  base: '/',
  plugins: [react()],
})
