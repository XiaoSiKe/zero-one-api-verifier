import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const verifierTarget = 'http://127.0.0.1:8012';
const verifierProxy = {
  '/app': {
    target: verifierTarget,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/app/, '') || '/',
  },
  '^/(static|claude|openai|gemini|leaderboard|faq|api|r|healthz|robots\\.txt|llms\\.txt|sitemap\\.xml)(/|$)': {
    target: verifierTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: verifierProxy },
  preview: { proxy: verifierProxy },
});
