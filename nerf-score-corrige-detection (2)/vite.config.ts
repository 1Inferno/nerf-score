import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

function collectProjectFiles(rootDir: string): Array<{path: string; encoding: 'utf8' | 'base64'; content: string}> {
  const results: Array<{path: string; encoding: 'utf8' | 'base64'; content: string}> = [];
  const allowRootFiles = new Set(['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']);
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico']);

  const walk = (relDir: string) => {
    const absDir = path.join(rootDir, relDir);
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, {withFileTypes: true})) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relPath === 'src' || relPath === 'public' || relPath.startsWith('src/') || relPath.startsWith('public/')) {
          if (!relPath.includes('node_modules') && !relPath.includes('dist')) {
            walk(relPath);
          }
        }
      } else if (entry.isFile()) {
        if (!relDir && !allowRootFiles.has(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const absFile = path.join(rootDir, relPath);
        if (binaryExts.has(ext)) {
          results.push({path: relPath, encoding: 'base64', content: fs.readFileSync(absFile).toString('base64')});
        } else {
          results.push({path: relPath, encoding: 'utf8', content: fs.readFileSync(absFile, 'utf8')});
        }
      }
    }
  };

  walk('');
  return results;
}

function projectSourcesPlugin(): Plugin {
  const virtualModuleId = 'virtual:project-sources';
  const resolvedVirtualModuleId = '\0' + virtualModuleId;
  return {
    name: 'nerf-score-project-sources',
    resolveId(id) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        const files = collectProjectFiles(__dirname);
        return `export const PROJECT_FILES = ${JSON.stringify(files)};`;
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      projectSourcesPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'],
        manifest: {
          id: '/',
          name: 'NERF SCORE',
          short_name: 'NERF SCORE',
          description: 'Système intelligent d’analyse vidéo, reconnaissance de cible et calcul automatique de score pour tirs Nerf.',
          theme_color: '#070B14',
          background_color: '#070B14',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          scope: '/',
          lang: 'fr',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
