// Decides what a bank transaction means for Scoffers. Pure functions, no I/O,
// so they can be tested without a bank connection.
//
// Amount convention here: positive = money IN, negative = money OUT.
// (Plaid uses the opposite sign; the sync flips it before calling us.)

const DAY = 24 * 60 * 60 * 1000;

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// Is `iso` within `tol` days of one of `days` (days of month) in the
// previous, same, or next month? Handles weekend/holiday shifts.
export function nearScheduledDay(iso, days, tol = 3) {
  if (!days?.length) return false;
  const t = toUTC(iso);
  const [y, m] = iso.split('-').map(Number);
  for (const off of [-1, 0, 1]) {
    for (const day of days) {
      const c = Date.UTC(y, m - 1 + off, day);
      if (Math.abs(t - c) <= tol * DAY) return true;
    }
  }
  return false;
}

const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const mentions = (text, mask) => !!mask && String(text || '').includes(mask);

/**
 * @param txn  { amount, date, name, accountKind: 'savings'|'checking' }
 * @param ctx  { fundingRule, variableRule, savingsMask, checkingMask,
 *               counterpart(amount, date) -> boolean  // a mirror transfer exists on the other account }
 * @returns { kind, action, needsReview, note }
 *   action: 'split' | 'catch_all' | 'none'
 */
export function classify(txn, ctx) {
  const { amount, date, name, accountKind } = txn;
  const fund = ctx.fundingRule;
  const vari = ctx.variableRule;

  if (accountKind === 'savings') {
    if (amount > 0) {
      if (fund && sameMoney(amount, fund.amount) && nearScheduledDay(date, fund.days_of_month, fund.tolerance_days ?? 3)) {
        return { kind: 'jar_funding', action: 'split', needsReview: false, note: 'Jar funding' };
      }
      if (mentions(name, ctx.checkingMask) || ctx.counterpart?.(amount, date)) {
        return { kind: 'sweep', action: 'catch_all', needsReview: false, note: 'Leftover from checking' };
      }
      return { kind: 'other_transfer', action: 'catch_all', needsReview: true, note: name };
    }
    // Money leaving savings: someone needs to say which jar paid.
    return { kind: 'jar_withdrawal', action: 'none', needsReview: true, note: name };
  }

  // checking
  if (amount > 0) {
    if (vari && sameMoney(amount, vari.amount) && nearScheduledDay(date, vari.days_of_month, vari.tolerance_days ?? 3)) {
      return { kind: 'variable_deposit', action: 'none', needsReview: false, note: 'Pay-period deposit' };
    }
    if (mentions(name, ctx.savingsMask) || ctx.counterpart?.(amount, date)) {
      // Jar money arriving: the Inbox asks which charges it paid for, so they don't count against What's Left.
      return { kind: 'jar_withdrawal', action: 'none', needsReview: true, note: 'From Joint Savings' };
    }
    return { kind: 'other_transfer', action: 'none', needsReview: false, note: name };
  }
  if (mentions(name, ctx.savingsMask) || ctx.counterpart?.(amount, date)) {
    return { kind: 'sweep', action: 'none', needsReview: false, note: 'To Joint Savings' };
  }
  return { kind: 'regular', action: 'none', needsReview: false, note: name };
}

/**
 * How a jar-funding deposit splits. If the allotments don't add up to the
 * deposit, nothing is guessed: it all goes to the catch-all for review.
 */
export function planSplit(amount, jars) {
  const active = jars.filter((j) => !j.archived);
  const total = active.reduce((s, j) => s + Number(j.per_deposit), 0);
  if (sameMoney(total, amount)) {
    return {
      ok: true,
      lines: active.filter((j) => Number(j.per_deposit) > 0).map((j) => ({ jar_id: j.id, amount: Number(j.per_deposit) })),
    };
  }
  const catchAll = active.find((j) => j.is_catch_all);
  return { ok: false, lines: [{ jar_id: catchAll.id, amount }], reason: `Allotments total $${total.toFixed(2)}, deposit was $${Number(amount).toFixed(2)}` };
}
