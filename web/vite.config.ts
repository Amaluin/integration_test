import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { port: 5173, host: true },
  preview: { port: 5173, host: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
