import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTrainingCases, validateProposal } from './train-offline.mjs';

function decision(overrides = {}) {
  return {
    kind: 'decision', outcome: 'executed', _source: 'run.jsonl', _line: 1,
    state: { state_type: 'monster', player: { hp: 4 } },
    candidates: [{ id: 'a0', label: 'Strike', command: { action: 'play_card', card_index: 0 } }],
    chosen: { id: 'a0', label: 'Strike' }, answer: { choice: 'a0', confidence: 0.2 },
    ...overrides,
  };
}

test('training evidence selects decisions that precede a recorded defeat', () => {
  const cases = selectTrainingCases([
    decision(),
    { kind: 'run_end', outcome: 'defeat', _source: 'run.jsonl', _line: 2 },
  ]);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].sample_id, 'run.jsonl:1');
  assert.equal(cases[0].run_outcome, 'defeat');
});

test('training proposal rejects any candidate ID outside the recorded legal set', () => {
  const cases = [{ sample_id: 'run.jsonl:1', candidates: [{ id: 'a0', label: 'Strike' }] }];
  const proposal = validateProposal({
    schemaVersion: 'jev-training-proposal-v1',
    summary: 'Observed evidence only.',
    evidence: [{ sample_id: 'run.jsonl:1', observation: 'A recorded fact.' }, { sample_id: 'missing', observation: 'Ignore.' }],
    training_profile: { schemaVersion: 'jev-offline-profile-v1', name: 'bounded' },
    candidate_changes: [
      { sample_id: 'run.jsonl:1', choice_id: 'a0', reason: 'Legal.' },
      { sample_id: 'run.jsonl:1', choice_id: 'invented', reason: 'Not legal.' },
    ],
  }, cases);
  assert.deepEqual(proposal.evidence.map(item => item.sample_id), ['run.jsonl:1']);
  assert.deepEqual(proposal.candidate_changes.map(item => item.choice_id), ['a0']);
  assert.equal(proposal.rejected_candidate_changes.length, 1);
});
