import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTrainingProfile, validateTrainingProfile } from '../training-profile.mjs';
import { factoredQuestion } from '../factored.mjs';

const profile = overrides => validateTrainingProfile({
  schemaVersion: 'jev-offline-profile-v1',
  name: 'test profile',
  strategy_context: 'Preserve HP when two lines make equal progress.',
  state_fact_focus: 'Compare incoming attack with block and current HP.',
  state_facts: [{ key: 'enemy_hp', path: 'battle.enemies[].hp', rationale: 'Check whether a legal attack secures a kill.' }],
  factor_questions: { safe: 'Does this candidate survive the shown attack?', progress: '', waste: '' },
  short_memory_guidance: 'Use only the bounded prior observations.',
  candidate_representation: 'Treat forecast values as partial estimates.',
  ...overrides,
});

test('offline training profile adds bounded guidance without changing candidate IDs', () => {
  const question = {
    state: { facts: [{ name: 'block', value: 3 }], player: { hp: 8 }, battle: { enemies: [{ hp: 3 }, { hp: 5 }] } },
    questions: { move: { type: 'choice', instructions: 'Choose one.', criteria: {
      a0: JSON.stringify({ sequence: [{ label: 'Strike' }], first_action_rules: 'legal' }),
      a1: JSON.stringify({ sequence: [{ label: 'Defend' }], first_action_rules: 'legal' }),
    } } },
  };
  const recent = { sameFight: [{ floor: 1, action: { label: 'Bash' } }] };
  const changed = applyTrainingProfile(question, profile(), { recent });
  assert.deepEqual(Object.keys(changed.questions.move.criteria), ['a0', 'a1']);
  assert.equal(JSON.parse(changed.questions.move.criteria.a0).sequence[0].label, 'Strike');
  assert.equal(JSON.parse(changed.questions.move.criteria.a0).training_interpretation, 'Treat forecast values as partial estimates.');
  assert.deepEqual(changed.state.training_facts[0].value, [3, 5]);
  assert.deepEqual(changed.state.training_short_memory.observations, recent);
  assert.equal(question.state.training_facts, undefined);
});

test('invalid or executable state fact paths are rejected', () => {
  assert.throws(() => profile({ state_facts: [{ key: 'bad', path: 'player.__proto__.constructor', rationale: '' }] }), /safe visible-state path/);
  assert.throws(() => profile({ state_facts: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, path: 'player.hp' })) }), /at most six/);
  assert.throws(() => profile({ strategy_context: 'x'.repeat(1201) }), /exceeds/);
});

test('no profile leaves the original Jev question untouched', () => {
  const question = { state: { player: { hp: 7 } }, questions: { move: { criteria: { a0: 'Strike' } } } };
  assert.equal(applyTrainingProfile(question, null), question);
});

test('reviewed factor questions reach Jev through the existing factored layer', () => {
  const state = {
    state_type: 'monster',
    run: { act: 1, floor: 2 },
    player: { hp: 8, max_hp: 12, block: 0, energy: 1, max_energy: 3, hand: [], relics: [], potions: [] },
    battle: { turn: 'player', is_play_phase: true, round: 1, enemies: [] },
  };
  const question = factoredQuestion(state, [{ id: 'a0', label: 'End turn', command: { action: 'end_turn' }, details: {} }], { trainingProfile: profile() });
  assert.equal(question.questions.safe_a0.instructions.question, 'Does this candidate survive the shown attack?');
  assert.equal(question.questions.prog_a0.instructions.question.startsWith('Given `state`'), true);
});
