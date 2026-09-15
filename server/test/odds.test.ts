import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingLineValue, impliedProb, netUnits, pickedFrom, profitOnWin, settle, type Lines } from '../src/odds.js';

const lines: Lines = { provider: 'DK', spreadHome: -4.5, spreadHomePrice: -112, spreadAwayPrice: -108, total: 53.5, overPrice: -120, underPrice: 100, mlHome: -218, mlAway: 180 };

test('profit on win follows American odds', () => {
  assert.equal(profitOnWin(1, -110).toFixed(4), '0.9091');
  assert.equal(profitOnWin(1, 180), 1.8);
  assert.equal(profitOnWin(2, -200), 1);
});

test('implied probability', () => {
  assert.equal(impliedProb(-110).toFixed(4), '0.5238');
  assert.equal(impliedProb(100), 0.5);
  assert.equal(impliedProb(180).toFixed(4), '0.3571');
});

test('spread settlement from the picked side', () => {
  // BUF (home) -4.5, wins 27-20 -> covers by 2.5
  assert.deepEqual(settle('spread', 'home', -4.5, 27, 20), { result: 'win', margin: 2.5 });
  // DET (away) +4.5, loses 20-27 -> loses by 7, +4.5 -> -2.5
  assert.deepEqual(settle('spread', 'away', 4.5, 27, 20), { result: 'loss', margin: -2.5 });
  // push on a whole number
  assert.deepEqual(settle('spread', 'home', -7, 27, 20), { result: 'push', margin: 0 });
});

test('total and moneyline settlement', () => {
  assert.equal(settle('total', 'over', 53.5, 27, 27).result, 'win');
  assert.equal(settle('total', 'under', 53.5, 27, 27).result, 'loss');
  assert.equal(settle('total', 'under', 54, 27, 27).result, 'push');
  assert.equal(settle('moneyline', 'away', null, 20, 27).result, 'win');
  assert.equal(settle('moneyline', 'home', null, 20, 20).result, 'push');
});

test('net units', () => {
  assert.equal(netUnits('loss', 1.5, -110), -1.5);
  assert.equal(netUnits('push', 1, -110), 0);
  assert.equal(netUnits('win', 1, 180), 1.8);
});

test('picked side extraction', () => {
  assert.deepEqual(pickedFrom(lines, 'spread', 'away'), { line: 4.5, price: -108 });
  assert.deepEqual(pickedFrom(lines, 'total', 'under'), { line: 53.5, price: 100 });
  assert.deepEqual(pickedFrom(lines, 'moneyline', 'away'), { line: null, price: 180 });
});

test('closing line value is positive when we beat the close', () => {
  // We took DET +6; closed at +4.5 -> we were 1.5 better.
  assert.equal(closingLineValue('spread', 'away', 6, -110, lines), 1.5);
  // We laid BUF -3; closed at -4.5 -> +1.5.
  assert.equal(closingLineValue('spread', 'home', -3, -110, lines), 1.5);
  // Over 52.5 vs close 53.5 -> +1. Under 52.5 vs close 53.5 -> -1.
  assert.equal(closingLineValue('total', 'over', 52.5, -110, lines), 1);
  assert.equal(closingLineValue('total', 'under', 52.5, -110, lines), -1);
  // Took DET +200, closed +180 -> market moved toward us: positive prob points.
  const ml = closingLineValue('moneyline', 'away', null, 200, lines)!;
  assert.ok(ml > 2 && ml < 3, `got ${ml}`);
});
