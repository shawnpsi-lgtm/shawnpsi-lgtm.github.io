import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:43147',
    },
  },
  // dev.html, not index.html: index.html is the deployed static site.
  build: {
    outDir: 'dist',
    rollupOptions: { input: new URL('./dev.html', import.meta.url).pathname },
  },
})
