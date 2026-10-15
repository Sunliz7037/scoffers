// Scoffers server.
// Phase 1: serves the installable web app.
// Phase 2 adds the Plaid routes here (bank secrets live only on this server).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Single-page app: anything else gets the app shell.
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Scoffers listening on ${PORT}`));
