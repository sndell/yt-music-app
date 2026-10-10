import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

// Slot 0 is the main checkout (port 5173). A worktree writes dev/.dev-slot.
function readDevSlotFile(): string {
  for (const relative of ['../dev/.dev-slot', '../app/.dev-slot']) {
    try {
      return fs.readFileSync(path.resolve(import.meta.dirname, relative), 'utf8')
    } catch {
      // Missing slot file; try the next location.
    }
  }
  return '0'
}

function devSlot(): number {
  const fromEnv = process.env.DEV_SLOT?.trim()
  const raw = fromEnv ? fromEnv : readDevSlotFile()
  const slot = Number.parseInt(raw.trim().replace(/^\uFEFF/, ''), 10)
  return Number.isNaN(slot) || slot < 0 ? 0 : slot
}

const uiPort = 5173 + devSlot()

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: uiPort,
    strictPort: true,
  },
})
