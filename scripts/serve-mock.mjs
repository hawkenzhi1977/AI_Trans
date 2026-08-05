// 本地 Mock YouTube 站點伺服——E2E 測試的獨立宿主。
// 提供一個 /watch 頁面，內嵌模擬播放器與可控字幕，供擴充在真實瀏覽器環境驗證。
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const fixtureDir = resolve(__dirname, '../test/fixtures/mock-youtube');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const PORT = Number(process.env.MOCK_PORT ?? 8721);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  let pathname = url.pathname;

  // timedtext 字幕端點：返回固定 JSON 字幕（與 app.js LINES 一致，供擴充抓取）。
  if (pathname === '/timedtext') {
    const lines = [
      'Hello and welcome',
      'This is the second line',
      'We are testing subtitles',
      'Translation should appear below',
    ];
    const body = JSON.stringify({
      events: lines.map((text, i) => ({
        tStartMs: i * 2000,
        dDurationMs: 2000,
        segs: [{ utf8: text }],
      })),
      lang: 'en',
      videoId: 'abc123',
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  if (pathname.endsWith('/')) pathname += 'index.html';

  let file = join(fixtureDir, pathname);
  // SPA 風格回退：未知路徑（如 /watch）一律返回 index.html
  if (!file.startsWith(fixtureDir) || !existsSync(file)) {
    file = join(fixtureDir, 'index.html');
  }

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
  });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`mock-youtube serving on http://localhost:${PORT}`);
});
