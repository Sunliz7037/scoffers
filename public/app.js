import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, JAR_DEPOSIT_DAYS } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

let session = null;
let me = null; // { user_id, display_name }
let members = {}; // user_id -> display_name

/* ---------- helpers ---------- */

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => fmt.format(Number(n) || 0);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const parseAmount = (v) => {
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? round2(n) : NaN;
};

function localDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
function today() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12);
}
const monthYear = (iso) => localDate(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const shortDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Jar-funding deposits after today, up to and including the target date.
function depositsUntil(targetIso) {
  const end = localDate(targetIso);
  const now = today();
  let count = 0;
  const d = new Date(now.getFullYear(), now.getMonth(), 1, 12);
  while (d <= end) {
    for (const day of JAR_DEPOSIT_DAYS) {
      const dep = new Date(d.getFullYear(), d.getMonth(), day, 12);
      if (dep > now && dep <= end) count++;
    }
    d.setMonth(d.getMonth() + 1);
  }
  return count;
}

function nextDepositDate() {
  const now = today();
  for (let i = 0; i < 3; i++) {
    for (const day of JAR_DEPOSIT_DAYS) {
      const dep = new Date(now.getFullYear(), now.getMonth() + i, day, 12);
      if (dep > now) return dep;
    }
  }
  return null;
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), 2800);
}

function fail(err) {
  console.error(err);
  toast(err?.message || 'Something went wrong');
}

/* ---------- data ---------- */

async function loadJars() {
  const [{ data, error }, { data: wd, error: e2 }] = await Promise.all([
    sb.from('jar_balances').select('*').eq('archived', false).order('sort_order'),
    sb.from('allocations').select('jar_id, amount').eq('kind', 'withdrawal'),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  const spent = {};
  for (const w of wd || []) spent[w.jar_id] = (spent[w.jar_id] || 0) - Number(w.amount);
  return data.map((j) => ({
    ...j,
    balance: Number(j.balance),
    per_deposit: Number(j.per_deposit),
    spent: round2(spent[j.id] || 0),
  }));
}
async function loadAccounts() {
  const { data, error } = await sb.from('accounts').select('*');
  if (error) throw error;
  return data;
}
async function loadFundingRule() {
  const { data, error } = await sb.from('transfer_rules').select('*').eq('action', 'split_jars').eq('active', true).maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------- jar status ---------- */

function jarStatus(j) {
  if (j.mode === 'stash') {
    return { left: j.is_catch_all ? 'Catch-all for anything unlabeled' : 'Just stashing', pill: null };
  }
  if (j.mode === 'fill_spend') {
    return {
      left: j.per_deposit > 0 ? `+${money(j.per_deposit)} each deposit` : 'No regular allotment',
      pill: { cls: 'gold', text: `${money(j.balance)} ready` },
    };
  }
  // goal: progress counts what's in the jar plus what's already been spent from it
  const target = Number(j.target_amount);
  const saved = round2(j.balance + j.spent);
  const pct = target > 0 ? Math.min(100, Math.max(0, (saved / target) * 100)) : 0;
  const left = `${money(saved)} saved of ${money(target)} · by ${monthYear(j.target_date)}`;
  if (saved >= target) return { left, pct, pill: { cls: 'good', text: 'Funded 🎉' } };
  const n = depositsUntil(j.target_date);
  const short = target - saved;
  if (n === 0) return { left, pct, pill: { cls: 'warn', text: `${money(short)} short` } };
  const need = short / n;
  if (j.per_deposit + 0.005 >= need) return { left, pct, pill: { cls: 'good', text: 'On track' } };
  return { left, pct, pill: { cls: 'warn', text: `Needs ${money(need)}/deposit` } };
}

function jarCard(j) {
  const s = jarStatus(j);
  return `
    <a class="card jar" href="#/jar/${j.id}">
      <div class="top">
        <div class="emoji" aria-hidden="true">${esc(j.emoji || '🫙')}</div>
        <div class="name">${esc(j.name)}</div>
        <div class="bal">${money(j.balance)}</div>
      </div>
      ${s.pct !== undefined ? `<div class="bar" aria-hidden="true"><span style="width:${s.pct.toFixed(1)}%"></span></div>` : ''}
      <div class="status">
        <span class="muted">${esc(s.left)}</span>
        ${s.pill ? `<span class="pill ${s.pill.cls}">${esc(s.pill.text)}</span>` : ''}
      </div>
    </a>`;
}

/* ---------- views ---------- */

function renderLogin(message = '') {
  $tabs.hidden = true;
  $app.innerHTML = `
    <section class="login">
      <div class="brand">
        <div class="coin" aria-hidden="true">🪙</div>
        <h1>Scoffers</h1>
        <div class="muted display" style="font-weight:500;font-style:italic">the Saunders Coffers</div>
      </div>
      <form id="login" class="card">
        <div class="field"><label for="email">Email</label>
          <input id="email" type="email" autocomplete="username" required></div>
        <div class="field"><label for="pw">Password</label>
          <input id="pw" type="password" autocomplete="current-password" required></div>
        <button class="btn primary block" type="submit">Open the coffers</button>
        ${message ? `<div class="error">${esc(message)}</div>` : ''}
      </form>
    </section>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('pw').value,
    });
    if (error) renderLogin("That email and password didn't match.");
  });
}

async function renderHome() {
  const [jars, accounts] = await Promise.all([loadJars(), loadAccounts()]);
  const total = round2(jars.reduce((s, j) => s + j.balance, 0));
  const savings = accounts.find((a) => a.kind === 'savings');
  const next = nextDepositDate();

  let recon = '';
  if (savings?.current_balance == null) {
    recon = `<div class="banner info">Add your Joint Savings balance in <a href="#/admin">Admin</a> to check the jars match Wells Fargo. The bank feed will do this automatically.</div>`;
  } else {
    const diff = round2(Number(savings.current_balance) - total);
    if (Math.abs(diff) < 0.005) {
      recon = `<div class="banner ok">✓ Jars match Wells Fargo to the penny.</div>`;
    } else if (diff > 0) {
      recon = `<div class="banner warn">Wells Fargo shows ${money(savings.current_balance)}; the jars hold ${money(total)}. ${money(diff)} isn't in a jar yet.
        <div style="margin-top:8px"><button class="btn gold" id="sweep">Put ${money(diff)} in Loose Change</button></div></div>`;
    } else {
      recon = `<div class="banner warn">The jars hold ${money(-diff)} more than Wells Fargo shows. A withdrawal probably still needs a jar.</div>`;
    }
  }

  $app.innerHTML = `
    <header class="masthead">
      <h1>Scoffers</h1>
      <div class="sub">the Saunders Coffers · hi, ${esc(me.display_name)}</div>
    </header>
    <section class="card hero">
      <div class="label">In the jars</div>
      <div class="big">${money(total)}</div>
      <div class="meta">${jars.length} jars${next ? ` · next funding ${next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</div>
    </section>
    ${recon}
    <section class="card">
      <div class="row"><h3 style="font-size:18px">What's Left</h3><span class="pill plain">Coming soon</span></div>
      <p class="muted small" style="margin:6px 0 0">Your variable-spend number for the pay period shows up here once Wells Fargo is connected.</p>
    </section>
    <div class="row" style="margin:18px 0 10px"><h2 style="font-size:20px">Jars</h2><a href="#/jars" class="muted small">See all</a></div>
    ${jars.slice(0, 4).map(jarCard).join('')}
  `;

  document.getElementById('sweep')?.addEventListener('click', async () => {
    const catchAll = jars.find((j) => j.is_catch_all);
    const diff = round2(Number(savings.current_balance) - total);
    const { error } = await sb.from('allocations').insert({ jar_id: catchAll.id, amount: diff, kind: 'adjustment', note: 'Matched to Wells Fargo balance' });
    if (error) return fail(error);
    toast(`${money(diff)} added to ${catchAll.name}`);
    route();
  });
}

async function renderJars() {
  const [jars, rule] = await Promise.all([loadJars(), loadFundingRule()]);
  const total = round2(jars.reduce((s, j) => s + j.balance, 0));
  const next = nextDepositDate();
  $app.innerHTML = `
    <div class="page-title"><h1>Jars</h1><span class="muted">${money(total)}</span></div>
    ${rule && next ? `<p class="muted small" style="margin:-8px 0 14px">Next ${money(rule.amount)} split: ${next.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>` : ''}
    ${jars.map(jarCard).join('')}
  `;
}

async function renderJar(id) {
  const jars = await loadJars();
  const j = jars.find((x) => x.id === id);
  if (!j) {
    $app.innerHTML = `<a class="back" href="#/jars">‹ Jars</a><div class="card">That jar isn't here anymore.</div>`;
    return;
  }
  const { data: history, error } = await sb
    .from('allocations')
    .select('id, amount, kind, note, created_at, created_by')
    .eq('jar_id', id)
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) throw error;

  const s = jarStatus(j);
  const catchAll = jars.find((x) => x.is_catch_all);
  const kindLabel = { opening: 'Starting balance', auto_split: 'Jar funding', manual: 'Added', withdrawal: 'Withdrawn', move: 'Moved', adjustment: 'Matched to bank' };

  $app.innerHTML = `
    <a class="back" href="#/jars">‹ Jars</a>
    <section class="card">
      <div class="row"><h1 style="font-size:24px">${esc(j.emoji || '🫙')} ${esc(j.name)}</h1></div>
      <div class="detail-bal">${money(j.balance)}</div>
      ${s.pct !== undefined ? `<div class="bar" aria-hidden="true"><span style="width:${s.pct.toFixed(1)}%"></span></div>` : ''}
      <div class="status jar" style="margin-top:10px;display:flex;justify-content:space-between;gap:8px;font-size:14px">
        <span class="muted">${esc(s.left)}</span>
        ${s.pill ? `<span class="pill ${s.pill.cls}">${esc(s.pill.text)}</span>` : ''}
      </div>
      <div class="actions">
        ${j.is_catch_all ? '' : `<button class="btn" data-act="add">＋ Add</button>`}
        <button class="btn" data-act="withdraw">− Withdraw</button>
        <button class="btn" data-act="move">⇄ Move</button>
      </div>
    </section>
    <section class="card history">
      <h3 style="font-size:18px;margin-bottom:6px">History</h3>
      ${history.length ? history.map((h) => `
        <div class="item">
          <div>
            <div>${esc(h.note || kindLabel[h.kind] || h.kind)}</div>
            <div class="muted small">${shortDate(h.created_at)}${h.created_by && members[h.created_by] ? ` · ${esc(members[h.created_by])}` : ''}</div>
          </div>
          <div class="${Number(h.amount) >= 0 ? 'amt-in' : 'amt-out'}">${Number(h.amount) >= 0 ? '+' : '−'}${money(Math.abs(h.amount))}</div>
        </div>`).join('') : '<p class="muted small">Nothing yet.</p>'}
    </section>
  `;

  $app.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'add') moneySheet({
        title: `Add to ${j.name}`,
        hint: `Comes out of ${catchAll.name} (${money(catchAll.balance)} there now).`,
        submit: 'Add',
        run: (amt, note) => sb.rpc('jar_move', { p_from: catchAll.id, p_to: j.id, p_amount: amt, p_note: note || `From ${catchAll.name}` }),
        done: (amt) => `${money(amt)} added to ${j.name}`,
      });
      if (act === 'withdraw') moneySheet({
        title: `Withdraw from ${j.name}`,
        hint: 'For money leaving Joint Savings, like a transfer to checking.',
        notePlaceholder: 'What was it for?',
        submit: 'Withdraw',
        run: (amt, note) => sb.rpc('jar_withdraw', { p_jar: j.id, p_amount: amt, p_note: note || null }),
        done: (amt) => `${money(amt)} withdrawn from ${j.name}`,
      });
      if (act === 'move') moneySheet({
        title: `Move from ${j.name}`,
        targets: jars.filter((x) => x.id !== j.id),
        submit: 'Move',
        run: (amt, note, to) => sb.rpc('jar_move', { p_from: j.id, p_to: to, p_amount: amt, p_note: note || null }),
        done: (amt, to) => `${money(amt)} moved to ${jars.find((x) => x.id === to)?.name}`,
      });
    })
  );
}

function moneySheet({ title, hint, targets, submit, notePlaceholder, run, done }) {
  $sheet.innerHTML = `
    <form class="inner" method="dialog">
      <h2>${esc(title)}</h2>
      ${hint ? `<p class="muted small" style="margin:-6px 0 12px">${esc(hint)}</p>` : ''}
      <div class="field"><label for="s-amt">Amount</label>
        <input id="s-amt" inputmode="decimal" placeholder="$0.00" required autocomplete="off"></div>
      ${targets ? `<div class="field"><label for="s-to">To</label>
        <select id="s-to">${targets.map((t) => `<option value="${t.id}">${esc(t.emoji || '')} ${esc(t.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="s-note">Note (optional)</label>
        <input id="s-note" placeholder="${esc(notePlaceholder || '')}" autocomplete="off"></div>
      <div class="error" id="s-err" hidden></div>
      <div class="btns">
        <button class="btn" type="button" id="s-cancel">Cancel</button>
        <button class="btn primary" type="submit">${esc(submit)}</button>
      </div>
    </form>`;
  $sheet.showModal();
  const form = $sheet.querySelector('form');
  $sheet.querySelector('#s-cancel').onclick = () => $sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const amt = parseAmount($sheet.querySelector('#s-amt').value);
    const note = $sheet.querySelector('#s-note').value.trim();
    const to = targets ? $sheet.querySelector('#s-to').value : null;
    const err = $sheet.querySelector('#s-err');
    if (!(amt > 0)) { err.textContent = 'Enter an amount above $0.'; err.hidden = false; return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const { error } = await run(amt, note, to);
    if (error) { err.textContent = error.message; err.hidden = false; btn.disabled = false; return; }
    $sheet.close();
    toast(done(amt, to));
    route();
  };
  setTimeout(() => $sheet.querySelector('#s-amt').focus(), 50);
}

async function renderAdmin() {
  const [jars, accounts, rule] = await Promise.all([loadJars(), loadAccounts(), loadFundingRule()]);
  const savings = accounts.find((a) => a.kind === 'savings');
  const allotTotal = round2(jars.reduce((s, j) => s + j.per_deposit, 0));
  const ruleAmt = rule ? Number(rule.amount) : null;
  const allotOk = ruleAmt == null || Math.abs(allotTotal - ruleAmt) < 0.005;

  $app.innerHTML = `
    <div class="page-title"><h1>Admin</h1></div>

    <h2 style="font-size:20px;margin:0 0 10px">Jars & allotments</h2>
    <div class="banner ${allotOk ? 'ok' : 'warn'}">
      Allotments total ${money(allotTotal)}${ruleAmt != null ? ` of the ${money(ruleAmt)} deposit` : ''}.
      ${allotOk ? '✓ Every dollar has a jar.' : allotTotal < ruleAmt ? `${money(ruleAmt - allotTotal)} left to assign; until then each deposit lands in Loose Change.` : `${money(allotTotal - ruleAmt)} over; until fixed each deposit lands in Loose Change.`}
    </div>
    ${jars.map((j) => jarEditor(j)).join('')}
    <button class="btn block" id="add-jar" style="margin-bottom:24px">＋ New jar</button>

    <h2 style="font-size:20px;margin:0 0 10px">Wells Fargo balance</h2>
    <form class="card" id="bal-form">
      <p class="muted small" style="margin:0 0 10px">Until the bank feed is connected, enter the Joint Savings balance so Scoffers can check the jars add up.</p>
      <div class="field"><label for="bal">Joint Savings …${esc(savings?.mask || '')}</label>
        <input id="bal" inputmode="decimal" value="${savings?.current_balance ?? ''}" placeholder="$0.00"></div>
      <button class="btn primary block" type="submit">Save balance</button>
      ${savings?.balance_updated_at ? `<p class="muted small" style="margin:8px 0 0">Last updated ${shortDate(savings.balance_updated_at)}</p>` : ''}
    </form>

    <h2 style="font-size:20px;margin:20px 0 10px">Record a jar deposit by hand</h2>
    <form class="card" id="dep-form">
      <p class="muted small" style="margin:0 0 10px">The bank feed will do this on the 5th and 15th. Until then: ${money(ruleAmt ?? 0)} splits across the jars; any other amount goes to Loose Change.</p>
      <div class="field"><label for="dep">Amount</label><input id="dep" inputmode="decimal" value="${ruleAmt ?? ''}"></div>
      <button class="btn gold block" type="submit">Record deposit</button>
    </form>

    <section class="card" style="margin-top:20px">
      <div class="row"><span>Signed in as <strong>${esc(me.display_name)}</strong></span>
      <button class="btn" id="signout">Sign out</button></div>
    </section>
  `;

  $app.querySelectorAll('form.jar-edit').forEach(wireJarEditor);
  document.getElementById('add-jar').onclick = () => newJarSheet(jars.length);

  document.getElementById('bal-form').onsubmit = async (e) => {
    e.preventDefault();
    const v = parseAmount(document.getElementById('bal').value);
    if (!Number.isFinite(v)) return toast('Enter the balance as a number');
    const { error } = await sb.from('accounts').update({ current_balance: v, balance_updated_at: new Date().toISOString() }).eq('id', savings.id);
    if (error) return fail(error);
    toast('Balance saved');
    route();
  };

  document.getElementById('dep-form').onsubmit = async (e) => {
    e.preventDefault();
    const v = parseAmount(document.getElementById('dep').value);
    if (!(v > 0)) return toast('Enter an amount above $0');
    if (!confirm(`Record a ${money(v)} deposit into the jars?`)) return;
    const { data, error } = await sb.rpc('jar_record_deposit', { p_amount: v, p_note: null });
    if (error) return fail(error);
    toast(data === 'split' ? `${money(v)} split across the jars` : `${money(v)} added to Loose Change`);
    route();
  };

  document.getElementById('signout').onclick = () => sb.auth.signOut();
}

function jarEditor(j) {
  const modeOpts = [
    ['goal', 'Goal (amount + date)'],
    ['fill_spend', 'Fill & spend'],
    ['stash', 'Stash'],
  ];
  return `
    <details class="card">
      <summary class="row">
        <span>${esc(j.emoji || '🫙')} <strong>${esc(j.name)}</strong></span>
        <span class="muted small">${money(j.per_deposit)}/deposit</span>
      </summary>
      <form class="jar-edit" data-id="${j.id}" data-balance="${j.balance}" data-catch="${j.is_catch_all}">
        <div class="grid-emoji field">
          <div><label>Emoji</label><input name="emoji" value="${esc(j.emoji || '')}" maxlength="4"></div>
          <div><label>Name</label><input name="name" value="${esc(j.name)}" required></div>
        </div>
        <div class="grid2 field">
          <div><label>Mode</label>
            <select name="mode" ${j.is_catch_all ? 'disabled' : ''}>
              ${modeOpts.map(([v, l]) => `<option value="${v}" ${j.mode === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div><label>Per deposit</label><input name="per_deposit" inputmode="decimal" value="${j.per_deposit}"></div>
        </div>
        <div class="grid2 field goal-only" ${j.mode === 'goal' ? '' : 'hidden'}>
          <div><label>Goal amount</label><input name="target_amount" inputmode="decimal" value="${j.target_amount ?? ''}"></div>
          <div><label>Goal date</label><input name="target_date" type="date" value="${j.target_date ?? ''}"></div>
        </div>
        <div class="grid2">
          <button class="btn primary" type="submit">Save</button>
          ${j.is_catch_all ? '' : `<button class="btn" type="button" data-archive>Retire jar</button>`}
        </div>
      </form>
    </details>`;
}

function readJarForm(form) {
  const f = new FormData(form);
  const mode = form.querySelector('[name=mode]').value;
  const row = {
    name: String(f.get('name') || '').trim(),
    emoji: String(f.get('emoji') || '').trim() || null,
    per_deposit: parseAmount(f.get('per_deposit') || 0),
  };
  if (!form.querySelector('[name=mode]').disabled) row.mode = mode;
  if (mode === 'goal') {
    row.target_amount = parseAmount(f.get('target_amount'));
    row.target_date = f.get('target_date') || null;
  } else {
    row.target_amount = null;
    row.target_date = null;
  }
  if (!row.name) return { error: 'Give the jar a name.' };
  if (!(row.per_deposit >= 0)) return { error: 'Per deposit must be $0 or more.' };
  if (mode === 'goal' && (!(row.target_amount > 0) || !row.target_date)) return { error: 'Goal jars need a goal amount and date.' };
  return { row };
}

function wireJarEditor(form) {
  const modeSel = form.querySelector('[name=mode]');
  modeSel.addEventListener('change', () => (form.querySelector('.goal-only').hidden = modeSel.value !== 'goal'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { row, error } = readJarForm(form);
    if (error) return toast(error);
    const { error: err } = await sb.from('jars').update(row).eq('id', form.dataset.id);
    if (err) return fail(err);
    toast('Jar saved');
    route();
  });
  form.querySelector('[data-archive]')?.addEventListener('click', async () => {
    if (Math.abs(Number(form.dataset.balance)) >= 0.005) {
      return toast('Move this jar’s money out first, then retire it.');
    }
    if (!confirm('Retire this jar? Its history stays.')) return;
    const { error } = await sb.from('jars').update({ archived: true, per_deposit: 0 }).eq('id', form.dataset.id);
    if (error) return fail(error);
    toast('Jar retired');
    route();
  });
}

function newJarSheet(count) {
  $sheet.innerHTML = `
    <form class="inner jar-edit" data-catch="false">
      <h2>New jar</h2>
      <div class="grid-emoji field">
        <div><label>Emoji</label><input name="emoji" value="🫙" maxlength="4"></div>
        <div><label>Name</label><input name="name" required></div>
      </div>
      <div class="grid2 field">
        <div><label>Mode</label>
          <select name="mode">
            <option value="fill_spend">Fill & spend</option>
            <option value="goal">Goal (amount + date)</option>
            <option value="stash">Stash</option>
          </select></div>
        <div><label>Per deposit</label><input name="per_deposit" inputmode="decimal" value="0"></div>
      </div>
      <div class="grid2 field goal-only" hidden>
        <div><label>Goal amount</label><input name="target_amount" inputmode="decimal"></div>
        <div><label>Goal date</label><input name="target_date" type="date"></div>
      </div>
      <div class="btns">
        <button class="btn" type="button" id="s-cancel">Cancel</button>
        <button class="btn primary" type="submit">Create jar</button>
      </div>
    </form>`;
  $sheet.showModal();
  const form = $sheet.querySelector('form');
  const modeSel = form.querySelector('[name=mode]');
  modeSel.onchange = () => (form.querySelector('.goal-only').hidden = modeSel.value !== 'goal');
  form.querySelector('#s-cancel').onclick = () => $sheet.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { row, error } = readJarForm(form);
    if (error) return toast(error);
    const { error: err } = await sb.from('jars').insert({ ...row, sort_order: count + 1 });
    if (err) return fail(err);
    $sheet.close();
    toast(`${row.name} created`);
    route();
  };
}

/* ---------- routing ---------- */

async function route() {
  if (!session) return renderLogin();
  if (!me) {
    const { data, error } = await sb.from('members').select('user_id, display_name');
    if (error) return fail(error);
    members = Object.fromEntries((data || []).map((m) => [m.user_id, m.display_name]));
    me = (data || []).find((m) => m.user_id === session.user.id);
    if (!me) {
      await sb.auth.signOut();
      return renderLogin("This login isn't set up for Scoffers.");
    }
  }
  $tabs.hidden = false;
  const [, page, id] = (location.hash || '#/home').split('/');
  const tab = page === 'jar' ? 'jars' : page || 'home';
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  try {
    if (page === 'jars') await renderJars();
    else if (page === 'jar' && id) await renderJar(id);
    else if (page === 'admin') await renderAdmin();
    else await renderHome();
    window.scrollTo(0, 0);
  } catch (err) {
    fail(err);
    $app.innerHTML = `<div class="card">Couldn't load that. <button class="btn" onclick="location.reload()">Try again</button></div>`;
  }
}

window.addEventListener('hashchange', route);

let booted = false;
sb.auth.onAuthStateChange((_event, s) => {
  const changed = (s?.user?.id || null) !== (session?.user?.id || null);
  session = s;
  if (!booted || changed) {
    booted = true;
    me = null;
    // Defer so Supabase finishes its own auth bookkeeping first.
    setTimeout(route, 0);
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
