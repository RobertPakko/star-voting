import { createHash } from 'node:crypto'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Writes the Content-Security-Policy into the built page.
 *
 * As a `<meta>` because GitHub Pages serves no headers of ours, and written
 * here rather than in index.html for two reasons: the one off-site address the
 * app talks to (the Supabase project) is only known at build time, and the dev
 * server could not live under it (hot reload is an inline script and a
 * websocket of its own). So `vite dev` has no policy and the build -- which is
 * what `npm run preview`, the browser suite and the site all run -- has this
 * one. See "The content security policy" in AGENTS.md before loosening it.
 */
function contentSecurityPolicy(supabaseUrl: string | undefined): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // The inline scripts the page carries (the one that sets the colour
        // scheme before first paint), allowed by what they say rather than by
        // allowing inline script at all.
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
          ([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
        )

        // The database, over https for reads and writes and wss for live
        // updates; and the one other API the app reads (the donate page's count).
        const connect = ["'self'", 'https://partners.every.org']
        if (supabaseUrl) {
          const { origin } = new URL(supabaseUrl)
          connect.push(origin, origin.replace(/^http/, 'ws'))
        }

        const policy = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')}`.trim(),
          // Mantine styles through `style` attributes and a <style> of its
          // own, neither of which can be named by a hash.
          "style-src 'self' 'unsafe-inline'",
          // data: and blob: for the QR code, and for small images and the
          // signature's font, which the build inlines.
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "media-src 'self'",
          `connect-src ${connect.join(' ')}`,
          "worker-src 'self'",
          "manifest-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')

        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
              injectTo: 'head-prepend',
            },
          ],
        }
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    // Served from the root of choicelab.app.
    base: '/',
    plugins: [react(), contentSecurityPolicy(env.VITE_SUPABASE_URL)],
    server: {
      // The intro recording's browser profile (scripts/intro/browser.mjs) holds
      // files open, and watching one while the browser runs crashes the server.
      watch: { ignored: ['**/.capture-profile/**'] },
    },
  }
})
