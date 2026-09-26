import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Design Inspector Tool — App A
// Single local browser app. No server DB. Direct browser->Ollama by default (see docs).
// Test config lives in vitest.config.ts (kept separate: vite 8 + vitest 3 typecheck).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
})
