import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // The offline diagnosis catalog is intentionally shipped as a lazy-loaded fallback chunk.
    chunkSizeWarningLimit: 10000
  },
  server: {
    port: 3000,
    open: true
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Keep native SQLite and large CXF tests deterministic on shared CI runners.
    maxWorkers: 2,
    setupFiles: './src/test/setup.js',
    exclude: ['node_modules/**', 'dist/**', 'release/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/test/**']
    }
  }
})
