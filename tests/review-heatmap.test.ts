import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heatmapWeeks, heatmapRange, monday, shiftDay} from '../src/review-heatmap';

test('grid width chooses full week columns and hidden dimensions remain unknown', () => {
  for (const value of [0, -1, NaN, Infinity]) assert.equal(heatmapWeeks(value), null);
  assert.equal(heatmapWeeks(21), 1);
  assert.equal(heatmapWeeks(22), 1);
  assert.equal(heatmapWeeks(43.999), 1);
  assert.equal(heatmapWeeks(44), 2);
  assert.equal(heatmapWeeks(924), 42);
  assert.equal(heatmapWeeks(220), 10);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => heatmapWeeks(924, value), RangeError);
});

test('ranges end at the current week, cover exact columns and move without overlaps', () => {
  const today = '2026-10-15', range = heatmapRange(today, 42);
  assert.deepEqual(range, {start:'2025-12-29', end:today, lastWeek:'2026-10-12'});
  const previous = heatmapRange(today, 42, shiftDay(range.lastWeek, -42 * 7));
  assert.equal(shiftDay(previous.end, 1), range.start);
  const next = heatmapRange(today, 42, shiftDay(previous.lastWeek, 42 * 7));
  assert.deepEqual(next, range);
  assert.deepEqual(heatmapRange(today, 42, '2030-01-01'), range);
  assert.equal(heatmapRange(today, 10, previous.lastWeek).lastWeek, previous.lastWeek);
});

test('calendar keys survive year, leap day, local midnight and daylight saving boundaries', () => {
  assert.equal(shiftDay('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDay('2024-02-29', 1), '2024-03-01');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(monday('2026-03-08'), '2026-03-02');
  assert.equal(monday('2026-10-15'), '2026-10-12');
  assert.deepEqual(heatmapRange('2026-10-18', 1), {start:'2026-10-12', end:'2026-10-18', lastWeek:'2026-10-12'});
  assert.deepEqual(heatmapRange('2026-10-19', 1), {start:'2026-10-19', end:'2026-10-19', lastWeek:'2026-10-19'});
});
