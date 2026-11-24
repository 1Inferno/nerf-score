import JSZip from 'jszip';
import {PROJECT_FILES} from 'virtual:project-sources';
import {triggerDownload} from '../db/indexedDb';

const DEPLOY_README = `# NERF SCORE — Projet Autonome

Ce dépôt contient l'intégralité du code source et des ressources PWA de **NERF SCORE**, prêt à être compilé et déployé indépendamment de Google AI Studio.

## Prérequis
- Node.js 20+
- npm ou pnpm

## Installation & Lancement
\`\`\`bash
npm install
npm run dev
\`\`\`

## Compilation Production (PWA Hors Ligne)
\`\`\`bash
npm run build
npm run preview
\`\`\`

Les fichiers générés dans \`dist/\` peuvent être déployés sur n'importe quel hébergeur statique HTTPS (Vercel, Netlify, Cloudflare Pages, Nginx local, GitHub Pages). HTTPS est requis par les navigateurs mobiles pour accéder à l'API caméra WebRTC (\`getUserMedia\`) et au Service Worker PWA.
`;

export async function exportStandaloneProjectZip(): Promise<{fileCount: number}> {
  const zip = new JSZip();
  zip.file('README.md', DEPLOY_README);

  for (const item of PROJECT_FILES) {
    if (item.encoding === 'base64') {
      zip.file(item.path, item.content, {base64: true});
    } else {
      zip.file(item.path, item.content);
    }
  }

  const blob = await zip.generateAsync({type: 'blob'});
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `nerf-score-projet-complet-${stamp}.zip`);
  return {fileCount: PROJECT_FILES.length + 1};
}
