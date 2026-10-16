import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commentTime} from '../src/comment-time';

test('today comments retain a calendar date and a zero-padded time', () => {
  const now = new Date(2026, 9, 14, 13, 28, 0);
  const result = commentTime(new Date(2026, 9, 14, 9, 5, 7).toISOString(), now);
  assert.equal(result.label, '10月14日 09:05');
  assert.equal(result.full, '2026年10月14日 09:05:07');
});
test('older comments display their year to distinguish annual dates', () => {
  assert.equal(commentTime(new Date(2025, 9, 14, 13, 28).toISOString(), new Date(2026, 9, 14)).label, '2025年10月14日 13:28');
});
