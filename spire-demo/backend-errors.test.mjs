import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JEV_BACKEND_FAILURE, jevBackendFailure } from './backend-errors.mjs';

test('Jev backend failures are explicit and preserve a safe cause chain', () => {
  const cause = new Error('HTTP 401');
  const error = jevBackendFailure('TypeSafe request rejected.', cause);

  assert.equal(error.code, JEV_BACKEND_FAILURE);
  assert.match(error.message, /^JEV_BACKEND_FAILURE:/);
  assert.equal(error.cause, cause);
  assert.doesNotMatch(error.message, /Retry with Resume|Luna|GPT/);
});
