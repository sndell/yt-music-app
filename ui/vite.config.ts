import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
  // Vite only reads cacheDir from config, so a named dev instance passes its
  // own through the env; the default keeps node_modules/.vite.
  cacheDir: process.env.YTM_VITE_CACHE_DIR || 'node_modules/.vite',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    // Default for a manual `pnpm dev`. The app passes --port and --strictPort.
    port: 5173,
    strictPort: true,
  },
})
