import { classify, planSplit, nearScheduledDay } from '../lib/classify.js';
import assert from 'node:assert/strict';
const fundingRule = { amount: 1380, days_of_month: [5, 15], tolerance_days: 3 };
const variableRule = { amount: 3033, days_of_month: [1, 15], tolerance_days: 3 };
const ctx = { fundingRule, variableRule, savingsMask: '0810', checkingMask: '9486', counterpart: () => false };
const c = (amount, date, name, accountKind, extra = {}) => classify({ amount, date, name, accountKind }, { ...ctx, ...extra });

// near-day handling incl. month wrap (1st on a weekend -> Dec 30)
assert.equal(nearScheduledDay('2026-11-05', [5, 15]), true);
assert.equal(nearScheduledDay('2026-11-17', [5, 15]), true);
assert.equal(nearScheduledDay('2026-11-10', [5, 15]), false);
assert.equal(nearScheduledDay('2026-12-30', [1, 15]), true);

assert.equal(c(1380, '2026-11-05', 'ONLINE TRANSFER FROM PRIMARY XXXX7649', 'savings').action, 'split');
assert.equal(c(1380, '2026-11-10', 'ONLINE TRANSFER', 'savings').needsReview, true);       // right amount, wrong day
assert.equal(c(1379, '2026-11-05', 'ONLINE TRANSFER', 'savings').needsReview, true);       // wrong amount
assert.equal(c(212.4, '2026-11-14', 'TRANSFER FROM XXXXXX9486', 'savings').kind, 'sweep');  // leftover sweep
assert.equal(c(212.4, '2026-11-14', 'TRANSFER IN', 'savings', { counterpart: () => true }).action, 'catch_all');
assert.equal(c(0.42, '2026-11-30', 'INTEREST PAYMENT', 'savings').needsReview, true);
const w = c(-300, '2026-11-20', 'TRANSFER TO XXXXXX9486', 'savings');
assert.equal(w.kind, 'jar_withdrawal'); assert.equal(w.needsReview, true);
assert.equal(c(3033, '2026-11-01', 'ONLINE TRANSFER', 'checking').kind, 'variable_deposit');
assert.equal(c(300, '2026-11-20', 'TRANSFER FROM XXXXXX0810', 'checking').kind, 'jar_withdrawal');
assert.equal(c(-212.4, '2026-11-14', 'TRANSFER TO XXXXXX0810', 'checking').kind, 'sweep');
assert.equal(c(-84.12, '2026-11-14', 'HEB #123', 'checking').kind, 'regular');

const jars = [
  { id: 'lc', per_deposit: 0, is_catch_all: true }, { id: 'it', per_deposit: 400 }, { id: 'md', per_deposit: 350 },
  { id: 'kp', per_deposit: 320 }, { id: 'hb', per_deposit: 182.5 }, { id: 'hm', per_deposit: 102.5 }, { id: 'hoa', per_deposit: 25 },
];
const ok = planSplit(1380, jars);
assert.equal(ok.ok, true); assert.equal(ok.lines.length, 6);
assert.equal(ok.lines.reduce((s, l) => s + l.amount, 0), 1380);
const bad = planSplit(1400, jars);
assert.equal(bad.ok, false); assert.deepEqual(bad.lines, [{ jar_id: 'lc', amount: 1400 }]);
console.log('all classification tests passed');
