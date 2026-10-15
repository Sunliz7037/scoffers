// What's Left for the variable-spend checking account. Pure functions shared by
// the app (browser) and the server (planned-item matching), and unit tested.
//
// Amounts: positive = money in, negative = money out. Dates: 'YYYY-MM-DD'.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (s, n) => new Date(toUTC(s) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);
const r2 = (n) => Math.round(n * 100) / 100;

// Pay periods follow the checking deposits: 1st–14th and 15th–end of month.
export function periodFor(today) {
  const [y, m, d] = today.split('-').map(Number);
  let start, end, nextStart, nextEnd;
  if (d < 15) {
    start = iso(y, m, 1); end = iso(y, m, 14);
    nextStart = iso(y, m, 15); nextEnd = iso(y, m, daysInMonth(y, m));
  } else {
    start = iso(y, m, 15); end = iso(y, m, daysInMonth(y, m));
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    nextStart = iso(ny, nm, 1); nextEnd = iso(ny, nm, 14);
  }
  return { start, end, nextStart, nextEnd, daysLeft: daysBetween(today, end) + 1 };
}

// Every date a planned item comes due between `from` and `to` (inclusive).
export function occurrences(item, from, to) {
  if (item.recurrence === 'one_time') {
    return item.due_date >= from && item.due_date <= to ? [item.due_date] : [];
  }
  const out = [];
  const [y0, m0, d0] = item.due_date.split('-').map(Number);
  const last = item.end_date || to;
  for (let i = 0; i < 600; i++) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const m = ((m0 - 1 + i) % 12) + 1;
    const date = iso(y, m, Math.min(d0, daysInMonth(y, m)));
    if (date > last || date > to) break;
    if (date >= from) out.push(date);
  }
  return out;
}

/**
 * @param o.today        'YYYY-MM-DD'
 * @param o.balance      checking current (posted) balance; pending items are applied on top
 * @param o.txns         checking transactions (recent ~60 days): { id, amount, date, pending, kind }
 * @param o.planned      planned_items (not archived)
 * @param o.matches      planned_matches: { planned_item_id, occurrence_date }
 * @param o.coverage     jar_coverage: { withdrawal_transaction_id, charge_transaction_id, amount }
 */
export function whatsLeft({ today, balance, txns, planned, matches, coverage }) {
  const p = periodFor(today);
  const lookback = addDays(today, -60);

  const coveredByCharge = {}, coveredByWithdrawal = {};
  for (const c of coverage) {
    coveredByCharge[c.charge_transaction_id] = (coveredByCharge[c.charge_transaction_id] || 0) + Number(c.amount);
    coveredByWithdrawal[c.withdrawal_transaction_id] = (coveredByWithdrawal[c.withdrawal_transaction_id] || 0) + Number(c.amount);
  }
  const pendingOut = r2(txns.filter((t) => t.pending && t.amount < 0).reduce((s, t) => s + Math.max(0, -t.amount - (coveredByCharge[t.id] || 0)), 0));

  // Pending transactions haven't hit the posted balance yet: charges come off, deposits go on
  // (the pay-period deposit often sits pending for a day).
  // (A pending charge already linked to jar money only counts for the part the jar didn't cover.)
  // Jar transfers are left out: jar money never changes What's Left.
  const pendingIn = r2(txns.filter((t) => t.pending && t.amount > 0 && t.kind !== 'jar_withdrawal').reduce((s, t) => s + t.amount, 0));

  // Posted spending this period, minus anything a jar paid for.
  const spent = r2(txns
    .filter((t) => !t.pending && t.amount < 0 && t.kind === 'regular' && t.date >= p.start && t.date <= p.end)
    .reduce((s, t) => s + Math.max(0, -t.amount - (coveredByCharge[t.id] || 0)), 0));

  // Jar money that arrived in checking and hasn't been matched to the charges it paid for.
  // It's in the balance, so it's set aside here to keep What's Left untouched by jars.
  // Only transfers still open in the Inbox count (history from before Scoffers is already settled).
  const waitingItems = txns
    .filter((t) => !t.pending && t.amount > 0 && t.kind === 'jar_withdrawal' && t.needs_review)
    .map((t) => ({ id: t.id, remaining: r2(t.amount - (coveredByWithdrawal[t.id] || 0)) }))
    .filter((w) => w.remaining > 0.004);
  const waiting = r2(waitingItems.reduce((s, w) => s + w.remaining, 0));

  // Planned items still owed: anything due by the end of this period (including overdue).
  const matched = new Set(matches.map((m) => `${m.planned_item_id}|${m.occurrence_date}`));
  const plannedList = [];
  const nextList = [];
  for (const item of planned) {
    for (const date of occurrences(item, lookback, p.nextEnd)) {
      const paid = matched.has(`${item.id}|${date}`);
      const row = { item, date, amount: Number(item.amount), paid, overdue: !paid && date < today };
      if (date <= p.end) plannedList.push(row);
      else if (date >= p.nextStart) nextList.push(row);
    }
  }
  plannedList.sort((a, b) => a.date.localeCompare(b.date));
  nextList.sort((a, b) => a.date.localeCompare(b.date));
  const plannedHeld = r2(plannedList.filter((x) => !x.paid).reduce((s, x) => s + x.amount, 0));
  const nextCommitted = r2(nextList.filter((x) => !x.paid).reduce((s, x) => s + x.amount, 0));

  const value = r2(Number(balance) + pendingIn - pendingOut - plannedHeld - waiting);
  return {
    period: p,
    whatsLeft: value,
    perDay: r2(value / Math.max(1, p.daysLeft)),
    spent,
    pending: pendingOut,
    planned: plannedHeld,
    waiting,
    waitingItems,
    left: Math.max(0, value),
    over: value < 0 ? r2(-value) : 0,
    plannedList,
    nextList,
    nextCommitted,
  };
}

/**
 * Which planned occurrence (if any) a posted checking charge pays.
 * With a merchant hint: the hint appears in the description and the amount is within
 * $5 or 5%. Without one: the exact amount. Either way, from 10 days before to 7 days
 * after the due date.
 */
export function matchPlanned(txn, planned, matches) {
  if (txn.pending || txn.amount >= 0) return null;
  const amt = -txn.amount;
  const taken = new Set(matches.map((m) => `${m.planned_item_id}|${m.occurrence_date}`));
  const name = String(txn.name || '').toLowerCase();
  const cands = [];
  for (const item of planned) {
    const hint = (item.merchant_hint || '').trim().toLowerCase();
    // Without a merchant hint, only an exact amount is trusted (groceries come in all sizes).
    const tol = hint ? Math.max(5, Number(item.amount) * 0.05) : 0.009;
    if (Math.abs(amt - Number(item.amount)) > tol) continue;
    if (hint && !name.includes(hint)) continue;
    for (const date of occurrences(item, addDays(txn.date, -7), addDays(txn.date, 10))) {
      if (taken.has(`${item.id}|${date}`)) continue;
      cands.push({ item, date, score: Math.abs(daysBetween(date, txn.date)) + Math.abs(amt - Number(item.amount)) + (hint ? -100 : 0) });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  return { planned_item_id: cands[0].item.id, occurrence_date: cands[0].date };
}
