import assert from 'node:assert/strict';
import { periodFor, occurrences, whatsLeft, matchPlanned } from '../public/whatsleft.js';

// Periods
assert.deepEqual(periodFor('2026-11-03'), { start: '2026-11-01', end: '2026-11-14', nextStart: '2026-11-15', nextEnd: '2026-11-30', daysLeft: 12 });
assert.deepEqual(periodFor('2026-12-20'), { start: '2026-12-15', end: '2026-12-31', nextStart: '2027-01-01', nextEnd: '2027-01-14', daysLeft: 12 });
assert.equal(periodFor('2027-02-28').end, '2027-02-28');
assert.equal(periodFor('2026-11-14').daysLeft, 1);

// Occurrences
const toll = { id: 't', recurrence: 'one_time', due_date: '2026-12-05', amount: 42.1 };
const trip = { id: 'k', recurrence: 'monthly', due_date: '2026-11-20', end_date: '2027-01-31', amount: 150 };
const rent31 = { id: 'r', recurrence: 'monthly', due_date: '2027-01-31', end_date: '2027-04-30', amount: 10 };
assert.deepEqual(occurrences(toll, '2026-11-01', '2026-12-31'), ['2026-12-05']);
assert.deepEqual(occurrences(trip, '2026-11-01', '2027-06-30'), ['2026-11-20', '2026-12-20', '2027-01-20']); // 3 payments then stops
assert.deepEqual(occurrences(rent31, '2027-01-01', '2027-04-30'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);

// What's Left: Nov 20, second-half period
const base = {
  today: '2026-11-20',
  balance: 2500, // posted checking balance
  txns: [
    { id: 'dep', amount: 3033, date: '2026-11-15', pending: false, kind: 'variable_deposit' },
    { id: 'heb', amount: -180, date: '2026-11-16', pending: false, kind: 'regular' },
    { id: 'old', amount: -99, date: '2026-11-10', pending: false, kind: 'regular' }, // last period: not "spent" now
    { id: 'pend', amount: -45.5, date: '2026-11-20', pending: true, kind: 'regular' },
    { id: 'jarin', amount: 300, date: '2026-11-18', pending: false, kind: 'jar_withdrawal', needs_review: true },
    { id: 'oldjar', amount: 450, date: '2026-10-02', pending: false, kind: 'jar_withdrawal', needs_review: false }, // settled history
    { id: 'soccer', amount: -300, date: '2026-11-18', pending: false, kind: 'regular' },
    { id: 'sweep', amount: -200, date: '2026-11-15', pending: false, kind: 'sweep' },
  ],
  planned: [toll, trip],
  matches: [],
  coverage: [],
};

// Before linking the soccer charge to the jar money:
let w = whatsLeft(base);
assert.equal(w.pending, 45.5);
assert.equal(w.spent, 480);         // HEB + soccer (not yet linked)
assert.equal(w.waiting, 300);       // jar money held until it's linked
assert.equal(w.planned, 150);       // trip payment on the 20th (toll is next period)
assert.equal(w.nextCommitted, 42.1); // next period is Dec 1–14: only the toll on Dec 5
assert.equal(w.whatsLeft, 2004.5);   // 2500 − 45.50 pending − 150 planned − 300 jar money waiting

// Link the soccer charge to the jar money: the jar paid for it, so it stops counting.
w = whatsLeft({ ...base, coverage: [{ withdrawal_transaction_id: 'jarin', charge_transaction_id: 'soccer', amount: 300 }] });
assert.equal(w.spent, 180);
assert.equal(w.waiting, 0);
assert.equal(w.whatsLeft, 2304.5);

// The trip payment posts and matches: no longer held.
w = whatsLeft({ ...base, matches: [{ planned_item_id: 'k', occurrence_date: '2026-11-20' }],
  coverage: [{ withdrawal_transaction_id: 'jarin', charge_transaction_id: 'soccer', amount: 300 }] });
assert.equal(w.planned, 0);
assert.equal(w.whatsLeft, 2454.5);
assert.equal(w.perDay, Math.round((2454.5 / 11) * 100) / 100); // Nov 20–30 = 11 days

// Overdue items still hold money in the current period.
w = whatsLeft({ ...base, today: '2026-12-08', planned: [toll] });
assert.equal(w.plannedList[0].overdue, true);
assert.equal(w.planned, 42.1);

// A pending deposit (the pay-period transfer before it posts) counts as money in.
w = whatsLeft({ ...base, balance: 845.98, planned: [], txns: [
  { id: 'pd', amount: 3033, date: '2026-11-15', pending: true, kind: 'variable_deposit' },
  { id: 'pc', amount: -50.44, date: '2026-11-15', pending: true, kind: 'regular' }] });
assert.equal(w.whatsLeft, 3828.54);
// A pending jar transfer into checking doesn't raise What's Left.
const wj = whatsLeft({ ...base, balance: 845.98, planned: [], txns: [
  { id: 'pd', amount: 3033, date: '2026-11-15', pending: true, kind: 'variable_deposit' },
  { id: 'pj', amount: 600, date: '2026-11-15', pending: true, kind: 'jar_withdrawal' }] });
assert.equal(wj.whatsLeft, 3878.98);
assert.equal(w.pending, 50.44);

// Overspent shows as "over", not a negative slice.
w = whatsLeft({ ...base, balance: 100, planned: [], txns: [] });
assert.equal(w.whatsLeft, 100);
w = whatsLeft({ ...base, balance: 10, planned: [], txns: [{ id: 'x', amount: -60, date: '2026-11-20', pending: true, kind: 'regular' }] });
assert.equal(w.left, 0); assert.equal(w.over, 50);

// Matching posted charges to planned items
const tollHint = { ...toll, merchant_hint: 'NTTA' };
assert.deepEqual(matchPlanned({ amount: -42.1, date: '2026-12-04', name: 'NTTA TOLLTAG 123', pending: false }, [tollHint], []),
  { planned_item_id: 't', occurrence_date: '2026-12-05' });
assert.deepEqual(matchPlanned({ amount: -44.0, date: '2026-12-04', name: 'NTTA TOLLTAG', pending: false }, [tollHint], []),
  { planned_item_id: 't', occurrence_date: '2026-12-05' });                    // within $5 with hint
assert.equal(matchPlanned({ amount: -44.0, date: '2026-12-04', name: 'NTTA', pending: false }, [toll], []), null); // no hint: exact only
assert.equal(matchPlanned({ amount: -42.1, date: '2026-12-04', name: 'HEB', pending: false }, [tollHint], []), null); // wrong merchant
assert.equal(matchPlanned({ amount: -42.1, date: '2026-11-01', name: 'NTTA', pending: false }, [tollHint], []), null); // way too early
assert.equal(matchPlanned({ amount: -42.1, date: '2026-12-04', name: 'NTTA', pending: true }, [tollHint], []), null);  // pending never matches
assert.equal(matchPlanned({ amount: -42.1, date: '2026-12-04', name: 'NTTA', pending: false }, [tollHint],
  [{ planned_item_id: 't', occurrence_date: '2026-12-05' }]), null);                                                     // already paid
assert.deepEqual(matchPlanned({ amount: -150, date: '2026-12-19', name: 'CAMP', pending: false }, [trip], []),
  { planned_item_id: 'k', occurrence_date: '2026-12-20' });                    // right month of a recurring item

console.log('all what\'s-left tests passed');
