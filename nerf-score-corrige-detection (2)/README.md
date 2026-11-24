# NERF SCORE — Projet Autonome

Ce dépôt contient l'intégralité du code source et des ressources PWA de **NERF SCORE**, prêt à être compilé et déployé indépendamment de Google AI Studio.

## Prérequis
- Node.js 20+
- npm ou pnpm

## Installation & Lancement
```bash
npm install
npm run dev
```

## Compilation Production (PWA Hors Ligne)
```bash
npm run build
npm run preview
```

Les fichiers générés dans `dist/` peuvent être déployés sur n'importe quel hébergeur statique HTTPS (Vercel, Netlify, Cloudflare Pages, Nginx local, GitHub Pages). HTTPS est requis par les navigateurs mobiles pour accéder à l'API caméra WebRTC (`getUserMedia`) et au Service Worker PWA.
