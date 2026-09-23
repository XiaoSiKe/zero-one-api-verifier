import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev points at a verifier on the loopback port. Compose overrides this
// with the in-network service name so the whole stack previews from one origin.
const verifierTarget = process.env.VERIFIER_TARGET || 'http://127.0.0.1:8012';
const verifierProxy = {
  '/app': {
    target: verifierTarget,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/app/, '') || '/',
  },
  '^/partner(/|$)': {
    target: verifierTarget,
    changeOrigin: false,
  },
  '^/(static|claude|openai|gemini|leaderboard|faq|api|r|healthz|robots\\.txt|llms\\.txt|sitemap\\.xml)(/|\\?|$)': {
    target: verifierTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: verifierProxy },
  preview: { proxy: verifierProxy },
});
