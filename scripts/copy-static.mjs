// copy-static.mjs — 構建後拷貝 manifest.json 等到 dist/。
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('manifest.json', 'dist/manifest.json', { force: true });
console.log('[build] copied static assets to dist/');
