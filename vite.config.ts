import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Served from the root of choicelab.app. It lived under /star-voting/ until
  // the rebrand, and site-root/star-voting/ is what still answers there: a
  // redirect, so that every link already sent out keeps working.
  base: '/',
  plugins: [react()],
})
