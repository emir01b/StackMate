'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 7002;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf' : 'font/ttf',
  '.txt' : 'text/plain',
  '.xml' : 'application/xml; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Yalnızca GET/HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  // Path temizle
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // Traversal koruma
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC, safePath);

  // Dizin → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    // robots.txt ve sitemap.xml gibi SEO dosyaları için 404 döndür
    const seoFiles = ['/robots.txt', '/sitemap.xml'];
    if (seoFiles.includes(urlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    // SPA fallback: tek sayfa → index.html
    filePath = path.join(PUBLIC, 'index.html');
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  // Cache headers
  const isAsset = ['.css','.js','.woff2','.woff','.ttf','.png','.jpg','.webp','.ico','.svg'].includes(ext);
  res.setHeader('Cache-Control', isAsset ? 'public, max-age=86400' : 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type':   mime,
      'Content-Length': data.length,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(data);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[stackmate-landing] Port ${PORT} kullanımda!`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[stackmate-landing] http://localhost:${PORT}`);
});
