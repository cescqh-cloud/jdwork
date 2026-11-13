import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-pi-workbench',
    rollupOptions: {
      input: fileURLToPath(new URL('./pi-workbench.html', import.meta.url)),
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
