import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// src/wayglim-rx3.tsx -> assets/wayglim-rx3.js, one self-contained script for project-rx3.html.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'assets',
    emptyOutDir: false,
    lib: {
      entry: new URL('./src/wayglim-rx3.tsx', import.meta.url).pathname,
      formats: ['iife'],
      name: 'wayglimRx3',
      fileName: () => 'wayglim-rx3.js',
    },
  },
})
