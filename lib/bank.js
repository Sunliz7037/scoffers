// Wells Fargo via Plaid: connect, sync, and turn transactions into jar activity.
// Everything here runs on the server. The Plaid access token never reaches a phone.
import express from 'express';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from './crypto.js';
import { classify, planSplit } from './classify.js';
import { matchPlanned } from '../public/whatsleft.js';

const REQUIRED = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'TOKEN_ENCRYPTION_KEY', 'APP_URL'];
const missing = () => REQUIRED.filter((k) => !process.env[k]);

let plaid, db;
function clients() {
  if (!plaid) {
    plaid = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
      baseOptions: { headers: { 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET } },
    }));
    db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return { plaid, db };
}

const appUrl = () => process.env.APP_URL.replace(/\/$/, '');
const plaidError = (e) => e?.response?.data?.error_message || e?.response?.data?.error_code || e.message;

// Date string (YYYY-MM-DD) in Central time.
function centralDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/* ---------- auth: only Liz and Adam ---------- */

async function requireMember(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'Sign in first' });
    const { db } = clients();
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Sign in again' });
    const { data: m } = await db.from('members').select('display_name').eq('user_id', data.user.id).maybeSingle();
    if (!m) return res.status(403).json({ error: 'Not a Scoffers member' });
    req.member = { id: data.user.id, name: m.display_name };
    next();
  } catch (e) {
    next(e);
  }
}

/* ---------- sync ---------- */

const syncing = new Map(); // item_id -> promise, so a webhook and a button press don't collide

export function syncItem(itemRow, opts = {}) {
  if (syncing.has(itemRow.item_id)) return syncing.get(itemRow.item_id);
  const p = doSync(itemRow, opts).finally(() => syncing.delete(itemRow.item_id));
  syncing.set(itemRow.item_id, p);
  return p;
}

async function doSync(itemRow, opts = {}) {
  const { plaid, db } = clients();
  const accessToken = decrypt(itemRow.access_token_encrypted);

  const [{ data: accounts }, { data: rules }, { data: jars }, { data: planned }, { data: plannedMatches }] = await Promise.all([
    db.from('accounts').select('*'),
    db.from('transfer_rules').select('*').eq('active', true),
    db.from('jars').select('*').eq('archived', false),
    db.from('planned_items').select('*').eq('archived', false),
    db.from('planned_matches').select('planned_item_id, occurrence_date'),
  ]);
  const matchesSoFar = [...(plannedMatches || [])];
  const byPlaidId = Object.fromEntries(accounts.filter((a) => a.plaid_account_id).map((a) => [a.plaid_account_id, a]));
  const savings = accounts.find((a) => a.kind === 'savings');
  const checking = accounts.find((a) => a.kind === 'checking');
  const ctxBase = {
    fundingRule: rules.find((r) => r.action === 'split_jars'),
    variableRule: rules.find((r) => r.action === 'start_period'),
    savingsMask: savings?.mask,
    checkingMask: checking?.mask,
  };
  const catchAll = jars.find((j) => j.is_catch_all);
  // Savings jar logic starts the day after Scoffers took over from Simplifi (Simplifi's
  // balances already include that day). Checking starts on the connection day itself.
  const connectedOn = centralDate(new Date(itemRow.created_at));
  const trackingStart = { savings: addDays(connectedOn, 1), checking: connectedOn };

  // Pull every change since the last cursor.
  let cursor = itemRow.cursor || undefined;
  const added = [], modified = [], removed = [];
  for (let page = 0; page < 50; page++) {
    const { data } = await plaid.transactionsSync({ access_token: accessToken, cursor, count: 500 });
    added.push(...data.added);
    modified.push(...data.modified);
    removed.push(...data.removed);
    cursor = data.next_cursor;
    if (!data.has_more) break;
  }

  // Removed rows (usually a pending item that just posted under a new id) are deleted at the
  // end, after anything linked to the pending version has moved to the posted one.
  const removedIds = removed.map((r) => r.transaction_id).filter(Boolean);

  const incoming = [...added, ...modified].filter((t) => byPlaidId[t.account_id]);
  const ids = incoming.map((t) => t.transaction_id);
  const existing = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('transactions').select('id, plaid_transaction_id, pending').in('plaid_transaction_id', ids.slice(i, i + 200));
    for (const row of data || []) existing[row.plaid_transaction_id] = row;
  }

  // A transfer between our two accounts shows up on both sides; find the mirror.
  const batch = incoming.map((t) => ({ account: byPlaidId[t.account_id], amount: -t.amount, date: t.date }));
  const mirrorIn = (account) => async (amount, date) => {
    const other = account.kind === 'savings' ? checking : savings;
    if (!other) return false;
    const inBatch = batch.some((b) => b.account.id === other.id && Math.abs(b.amount + amount) < 0.005 && Math.abs(Date.parse(b.date) - Date.parse(date)) <= 2 * 864e5);
    if (inBatch) return true;
    const { data } = await db.from('transactions').select('id').eq('account_id', other.id).eq('amount', -amount)
      .gte('date', addDays(date, -2)).lte('date', addDays(date, 2)).limit(1);
    return !!data?.length;
  };

  let processed = 0;
  for (const t of incoming) {
    const account = byPlaidId[t.account_id];
    const amount = Math.round(-t.amount * 100) / 100; // Plaid: positive = out. Ours: positive = in.
    const name = t.merchant_name ? `${t.merchant_name}` : t.name;
    const counterpartFound = await mirrorIn(account)(amount, t.date);
    const c = classify({ amount, date: t.date, name: t.name, accountKind: account.kind }, { ...ctxBase, counterpart: () => counterpartFound });

    const prior = existing[t.transaction_id];
    const isPosted = !t.pending;
    const inScope = t.date >= trackingStart[account.kind];
    const shouldProcess = isPosted && inScope && (!prior || prior.pending);

    const row = {
      account_id: account.id,
      plaid_transaction_id: t.transaction_id,
      pending_transaction_id: t.pending_transaction_id || null,
      amount,
      date: t.date,
      name,
      merchant: t.merchant_name || null,
      pending: !!t.pending,
      kind: c.kind,
      source: 'plaid',
      created_by: null,
    };
    // Jar money arriving in checking can be linked while it's still pending.
    const reviewWhilePending = t.pending && inScope && account.kind === 'checking' && c.kind === 'jar_withdrawal';
    if (shouldProcess) row.needs_review = c.needsReview;
    else if (!prior) row.needs_review = reviewWhilePending;

    const { data: saved, error } = await db.from('transactions').upsert(row, { onConflict: 'plaid_transaction_id' }).select('id').single();
    if (error) throw error;

    // A pending item just posted: carry its links (jar coverage, planned match) and Inbox state over.
    if (!t.pending && t.pending_transaction_id) {
      const { data: old } = await db.from('transactions').select('id, needs_review, kind').eq('plaid_transaction_id', t.pending_transaction_id).maybeSingle();
      if (old && old.id !== saved.id) {
        await db.from('jar_coverage').update({ charge_transaction_id: saved.id }).eq('charge_transaction_id', old.id);
        await db.from('jar_coverage').update({ withdrawal_transaction_id: saved.id }).eq('withdrawal_transaction_id', old.id);
        await db.from('planned_matches').update({ transaction_id: saved.id }).eq('transaction_id', old.id);
        // Keep whatever was decided on the pending version (linked, released, or still open).
        if (old.kind === 'jar_withdrawal' || old.kind === 'other_transfer') {
          await db.from('transactions').update({ needs_review: old.needs_review, kind: old.kind }).eq('id', saved.id);
        }
      }
    }

    if (!shouldProcess) continue;

    // A posted checking charge may be a planned item (the toll bill) arriving.
    if (account.kind === 'checking' && amount < 0 && planned?.length) {
      const hit = matchPlanned({ amount, date: t.date, name: `${t.merchant_name || ''} ${t.name}`, pending: false }, planned, matchesSoFar);
      if (hit) {
        const { error: mErr } = await db.from('planned_matches').insert({ ...hit, transaction_id: saved.id, status: 'paid' });
        if (!mErr) matchesSoFar.push(hit);
      }
    }

    // Never allocate the same transaction twice.
    const { data: already } = await db.from('allocations').select('id').eq('transaction_id', saved.id).limit(1);
    if (already?.length) continue;

    if (c.action === 'split') {
      const plan = planSplit(amount, jars);
      const lines = plan.lines.map((l) => ({ ...l, kind: plan.ok ? 'auto_split' : 'manual', note: plan.ok ? 'Jar funding' : 'Deposit (allotments didn’t match)', transaction_id: saved.id }));
      await db.from('allocations').insert(lines);
      if (!plan.ok) await db.from('transactions').update({ needs_review: true }).eq('id', saved.id);
      processed++;
    } else if (c.action === 'catch_all' && catchAll) {
      await db.from('allocations').insert({ jar_id: catchAll.id, amount, kind: 'manual', note: c.note, transaction_id: saved.id });
      processed++;
    }
  }

  if (removedIds.length) await db.from('transactions').delete().in('plaid_transaction_id', removedIds);

  // Balances: a live check with Wells Fargo when asked (Sync now), otherwise Plaid's latest copy.
  let acc;
  if (opts.live) {
    try { ({ data: acc } = await plaid.accountsBalanceGet({ access_token: accessToken })); }
    catch (e) { console.warn('live balance unavailable, using cached:', plaidError(e)); }
  }
  if (!acc) ({ data: acc } = await plaid.accountsGet({ access_token: accessToken }));
  for (const a of acc.accounts) {
    const ours = byPlaidId[a.account_id];
    if (!ours) continue;
    await db.from('accounts').update({
      current_balance: a.balances.current,
      available_balance: a.balances.available ?? a.balances.current,
      balance_updated_at: new Date().toISOString(),
    }).eq('id', ours.id);
  }

  await db.from('plaid_items').update({ cursor, status: 'ok', updated_at: new Date().toISOString() }).eq('id', itemRow.id);
  return { added: added.length, modified: modified.length, removed: removed.length, processed };
}

export async function syncAll(opts = {}) {
  const { plaid, db } = clients();
  const { data: items } = await db.from('plaid_items').select('*');
  const results = [];
  for (const item of items || []) {
    try {
      if (opts.live) {
        // Ask Plaid to check Wells Fargo now. New transactions arrive by webhook a minute or two later.
        try { await plaid.transactionsRefresh({ access_token: decrypt(item.access_token_encrypted) }); }
        catch (e) { console.warn('transactions refresh unavailable:', plaidError(e)); }
      }
      results.push(await syncItem(item, opts));
    } catch (e) {
      const msg = plaidError(e);
      const code = e?.response?.data?.error_code;
      await db.from('plaid_items').update({ status: code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : `error: ${msg}`.slice(0, 200), updated_at: new Date().toISOString() }).eq('id', item.id);
      results.push({ error: msg, code });
    }
  }
  return results;
}

/* ---------- routes ---------- */

export function bankRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '100kb' }));

  r.use((req, res, next) => {
    const m = missing();
    if (m.length) return res.status(503).json({ error: `Bank connection isn't configured yet. Missing: ${m.join(', ')}` });
    next();
  });

  // Plaid calls this when there is news. No login (it's Plaid calling), but all it
  // can do is trigger a sync of data we already have permission to read.
  r.post('/webhook', async (req, res) => {
    res.json({ ok: true });
    try {
      const { webhook_type, webhook_code, item_id } = req.body || {};
      const { db } = clients();
      const { data: item } = await db.from('plaid_items').select('*').eq('item_id', item_id).maybeSingle();
      if (!item) return;
      if (webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(webhook_code)) {
        await syncItem(item);
      } else if (webhook_type === 'ITEM' && ['ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(webhook_code)) {
        await db.from('plaid_items').update({ status: 'login_required', updated_at: new Date().toISOString() }).eq('id', item.id);
      } else if (webhook_type === 'ITEM' && webhook_code === 'LOGIN_REPAIRED') {
        await db.from('plaid_items').update({ status: 'ok', updated_at: new Date().toISOString() }).eq('id', item.id);
      }
    } catch (e) {
      console.error('webhook', plaidError(e));
    }
  });

  r.use(requireMember);

  r.get('/status', async (req, res, next) => {
    try {
      const { db } = clients();
      const [{ data: items }, { data: accounts }] = await Promise.all([
        db.from('plaid_items').select('institution, status, updated_at, created_at'),
        db.from('accounts').select('name, mask, kind, plaid_account_id, current_balance, available_balance, balance_updated_at'),
      ]);
      res.json({
        items: items || [],
        accounts: (accounts || []).map(({ plaid_account_id, ...a }) => ({ ...a, linked: !!plaid_account_id })),
      });
    } catch (e) { next(e); }
  });

  r.post('/link-token', async (req, res) => {
    try {
      const { plaid, db } = clients();
      const base = {
        user: { client_user_id: 'scoffers-household' },
        client_name: 'Scoffers',
        country_codes: ['US'],
        language: 'en',
        redirect_uri: `${appUrl()}/oauth`,
        webhook: `${appUrl()}/api/plaid/webhook`,
      };
      let request;
      if (req.body?.mode === 'update') {
        const { data: item } = await db.from('plaid_items').select('*').limit(1).maybeSingle();
        if (!item) return res.status(400).json({ error: 'Nothing to reconnect yet' });
        request = { ...base, access_token: decrypt(item.access_token_encrypted) };
      } else {
        request = { ...base, products: ['transactions'], transactions: { days_requested: 90 } };
      }
      const { data } = await plaid.linkTokenCreate(request);
      res.json({ link_token: data.link_token });
    } catch (e) {
      res.status(502).json({ error: plaidError(e) });
    }
  });

  r.post('/exchange', async (req, res) => {
    try {
      const { plaid, db } = clients();
      const publicToken = req.body?.public_token;
      if (!publicToken) return res.status(400).json({ error: 'Missing public token' });
      const { data: ex } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
      const institution = req.body?.institution || 'Wells Fargo';

      const { data: item, error } = await db.from('plaid_items').upsert({
        item_id: ex.item_id,
        access_token_encrypted: encrypt(ex.access_token),
        institution,
        status: 'ok',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'item_id' }).select('*').single();
      if (error) throw error;

      // Match Plaid's accounts to ours by the last four digits.
      const { data: acc } = await plaid.accountsGet({ access_token: ex.access_token });
      const { data: ours } = await db.from('accounts').select('*');
      const matched = [], ignored = [];
      for (const a of acc.accounts) {
        const mine = ours.find((o) => o.mask === a.mask);
        if (mine) {
          await db.from('accounts').update({ plaid_account_id: a.account_id }).eq('id', mine.id);
          matched.push(`${mine.name} …${a.mask}`);
        } else {
          ignored.push(`${a.name} …${a.mask}`);
        }
      }

      let sync = null;
      try { sync = await syncItem(item); } catch (e) { sync = { error: plaidError(e) }; }
      res.json({ matched, ignored, sync });
    } catch (e) {
      res.status(502).json({ error: plaidError(e) });
    }
  });

  r.post('/sync', async (req, res) => {
    try {
      res.json({ results: await syncAll({ live: true }) });
    } catch (e) {
      res.status(502).json({ error: plaidError(e) });
    }
  });

  r.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return r;
}
