import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  optimizeDeps: {
    include: [
      '@monaco-editor/react',
      'monaco-editor/esm/vs/editor/editor.api',
      'monaco-editor/esm/vs/editor/editor.all',
      'monaco-editor/esm/vs/language/json/monaco.contribution',
    ],
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
