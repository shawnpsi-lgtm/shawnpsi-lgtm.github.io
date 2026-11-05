import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// src/glass.tsx -> assets/glass.js + assets/glass.css, one self-contained script for the static pages.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'assets',
    emptyOutDir: false,
    lib: {
      entry: new URL('./src/glass.tsx', import.meta.url).pathname,
      formats: ['iife'],
      name: 'glass',
      fileName: () => 'glass.js',
      cssFileName: 'glass',
    },
  },
})
