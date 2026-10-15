// Scoffers server: serves the installable web app, and the Wells Fargo
// connection (Plaid). Bank secrets live only here, in environment variables.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankRouter, syncAll } from './lib/bank.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api/plaid', bankRouter());
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Single-page app (including /oauth, where Wells Fargo sends you back).
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Scoffers listening on ${PORT}`));

// Safety net in case a webhook is missed: sync every 4 hours.
if (process.env.PLAID_CLIENT_ID && process.env.SUPABASE_SECRET_KEY) {
  setInterval(() => syncAll().catch((e) => console.error('scheduled sync', e.message)), 4 * 60 * 60 * 1000);
}
