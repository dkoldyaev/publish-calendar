import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rawPort = process.env.WEB_PORT;
if (!rawPort || !/^\d+$/.test(rawPort.trim())) {
  console.error('ConfigurationError: WEB_PORT is required.');
  process.exit(1);
}

const port = Number(rawPort.trim());
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error(`ConfigurationError: WEB_PORT must be between 1 and 65535 (got "${rawPort}").`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const safePathname = path.posix
    .normalize(decodeURIComponent(reqUrl.pathname))
    .replace(/^(\.\.(\/|\\|$))+/, '');

  const relativePath = safePathname === '/' ? 'index.html' : safePathname.replace(/^\/+/, '');
  const candidatePath = path.join(distDir, relativePath);

  if (!candidatePath.startsWith(distDir)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let targetPath = candidatePath;
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      targetPath = path.join(distDir, 'index.html');
    }
  } catch {
    const ext = path.extname(relativePath);
    if (ext && ext !== '.html') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    targetPath = path.join(distDir, 'index.html');
  }

  try {
    const content = await fs.readFile(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    if (reqUrl.pathname === '/sw.js' || reqUrl.pathname === '/manifest.webmanifest') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (reqUrl.pathname.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }

    res.statusCode = 200;
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(content);
    }
  } catch {
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Web PWA server listening on 0.0.0.0:${port}`);
});
