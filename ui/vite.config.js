import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
// Slot 0 is the main checkout (port 5173). A worktree writes app/.dev-slot.
function devSlot() {
    const fromEnv = process.env.DEV_SLOT?.trim();
    const raw = fromEnv
        ? fromEnv
        : (() => {
            try {
                return fs.readFileSync(path.resolve(import.meta.dirname, '../app/.dev-slot'), 'utf8');
            }
            catch {
                return '0';
            }
        })();
    const slot = Number.parseInt(raw.trim().replace(/^\uFEFF/, ''), 10);
    return Number.isNaN(slot) || slot < 0 ? 0 : slot;
}
const uiPort = 5173 + devSlot();
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
});
