import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';
// Slot 0 is the main checkout (port 5173). A worktree writes app/dev/.dev-slot.
// Vite loads this file before vite.config.ts, so keep the two in sync.
function readDevSlotFile() {
    for (const relative of ['../app/dev/.dev-slot', '../dev/.dev-slot', '../app/.dev-slot']) {
        try {
            return fs.readFileSync(path.resolve(import.meta.dirname, relative), 'utf8');
        }
        catch {
            // Missing slot file; try the next location.
        }
    }
    return null;
}
// A linked worktree has ../.git as a file; the main checkout has a directory.
function isLinkedWorktree() {
    try {
        return fs.statSync(path.resolve(import.meta.dirname, '../.git')).isFile();
    }
    catch {
        return false;
    }
}
// The checkout slot drives the Vite port. DEV_SLOT is the instance slot and must not move it.
function devSlot() {
    const fromEnv = process.env.DEV_UI_SLOT?.trim();
    const raw = fromEnv ? fromEnv : readDevSlotFile();
    if (raw === null) {
        if (isLinkedWorktree()) {
            throw new Error('No app/dev/.dev-slot in this worktree. Run "tools/dev.py up" once to assign a slot.');
        }
        return 0;
    }
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
