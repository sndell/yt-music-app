import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
// https://vite.dev/config/
export default defineConfig({
    plugins: [
        tailwindcss(),
        react(),
        babel({
            // Vite pre-bundles dependencies into cacheDir/deps. Keep the plugin
            // off that directory, or the compiler is handed Vite's own chunks.
            exclude: /[\\/]node_modules[\\/]|[\\/]vite[\\/]deps[\\/]|\0rolldown\/runtime\.js/,
            presets: [reactCompilerPreset()],
        }),
    ],
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
});
