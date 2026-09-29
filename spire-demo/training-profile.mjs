import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TRAINING_PROFILE_SCHEMA = 'jev-offline-profile-v1';

const LIMITS = {
  name: 80,
  strategy_context: 1200,
  state_fact_focus: 800,
  state_fact_key: 64,
  state_fact_path: 160,
  state_fact_rationale: 240,
  factor_safe: 600,
  factor_progress: 600,
  factor_waste: 600,
  short_memory_guidance: 800,
  candidate_representation: 800,
};

function boundedText(value, field, maxLength) {
  if (value == null) return '';
  if (typeof value !== 'string') throw Error(`Training profile ${field} must be text.`);
  const text = value.trim();
  if (text.length > maxLength) throw Error(`Training profile ${field} exceeds ${maxLength} characters.`);
  return text;
}

export function validateTrainingProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Training profile must be an object.');
  if (input.schemaVersion !== TRAINING_PROFILE_SCHEMA) throw Error(`Expected ${TRAINING_PROFILE_SCHEMA}.`);
  const factor = input.factor_questions ?? {};
  if (!factor || typeof factor !== 'object' || Array.isArray(factor)) throw Error('Training profile factor_questions must be an object.');
  if (input.state_facts != null && (!Array.isArray(input.state_facts) || input.state_facts.length > 6)) throw Error('Training profile state_facts must contain at most six entries.');
  const stateFacts = (input.state_facts ?? []).map((fact, index) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) throw Error(`Training profile state_facts[${index}] must be an object.`);
    const key = boundedText(fact.key, `state_facts[${index}].key`, LIMITS.state_fact_key);
    const path = boundedText(fact.path, `state_facts[${index}].path`, LIMITS.state_fact_path);
    if (!/^[A-Za-z0-9_]+(?:\[\])?(?:\.[A-Za-z0-9_]+(?:\[\])?)*$/.test(path) || path.split(/[.\[\]]+/).some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw Error(`Training profile state_facts[${index}].path is not a safe visible-state path.`);
    }
    if (!key || !path) throw Error(`Training profile state_facts[${index}] needs a key and path.`);
    return { key, path, rationale: boundedText(fact.rationale, `state_facts[${index}].rationale`, LIMITS.state_fact_rationale) };
  });
  if (new Set(stateFacts.map(fact => fact.key)).size !== stateFacts.length) throw Error('Training profile state fact keys must be unique.');
  return {
    schemaVersion: TRAINING_PROFILE_SCHEMA,
    name: boundedText(input.name ?? 'offline proposal', 'name', LIMITS.name),
    strategy_context: boundedText(input.strategy_context, 'strategy_context', LIMITS.strategy_context),
    state_fact_focus: boundedText(input.state_fact_focus, 'state_fact_focus', LIMITS.state_fact_focus),
    state_facts: stateFacts,
    factor_questions: {
      safe: boundedText(factor.safe, 'factor_questions.safe', LIMITS.factor_safe),
      progress: boundedText(factor.progress, 'factor_questions.progress', LIMITS.factor_progress),
      waste: boundedText(factor.waste, 'factor_questions.waste', LIMITS.factor_waste),
    },
    short_memory_guidance: boundedText(input.short_memory_guidance, 'short_memory_guidance', LIMITS.short_memory_guidance),
    candidate_representation: boundedText(input.candidate_representation, 'candidate_representation', LIMITS.candidate_representation),
  };
}

export function loadTrainingProfile(path = process.env.SPIRE_TRAINING_PROFILE) {
  if (!path) return null;
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  return validateTrainingProfile(parsed);
}

function addGuidance(text, heading, guidance) {
  return guidance ? `${text}\n\n${heading}: ${guidance}` : text;
}

function safeVisiblePath(state, path) {
  let values = [state];
  for (const part of path.split('.')) {
    const flatten = part.endsWith('[]');
    const key = flatten ? part.slice(0, -2) : part;
    values = values.flatMap(value => {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return [];
      const next = value[key];
      return flatten ? (Array.isArray(next) ? next.slice(0, 20) : []) : [next];
    });
    if (!values.length) return null;
  }
  const clean = value => {
    if (typeof value === 'string') return value.slice(0, 300);
    if (Array.isArray(value)) return value.slice(0, 20).map(clean);
    if (value && typeof value === 'object') return '[object]';
    return value;
  };
  const result = values.length === 1 ? values[0] : values;
  return clean(result);
}

export function extractTrainingFacts(state, inputProfile) {
  if (!inputProfile) return [];
  const profile = validateTrainingProfile(inputProfile);
  return profile.state_facts.map(fact => ({ ...fact, value: safeVisiblePath(state, fact.path) }))
    .filter(fact => fact.value !== null);
}

export function applyTrainingProfile(question, inputProfile, { recent } = {}) {
  if (!inputProfile) return question;
  const profile = validateTrainingProfile(inputProfile);
  const result = {
    ...question,
    state: { ...question.state },
    questions: { ...question.questions },
  };

  if (profile.strategy_context) result.state.training_strategy_context = profile.strategy_context;
  if (profile.state_fact_focus) result.state.training_fact_focus = {
    guidance: profile.state_fact_focus,
    visible_facts: result.state.facts ?? [],
  };
  const trainingFacts = extractTrainingFacts(result.state, profile);
  if (trainingFacts.length) result.state.training_facts = trainingFacts;
  if (profile.short_memory_guidance) result.state.training_short_memory = {
    guidance: profile.short_memory_guidance,
    observations: recent ?? null,
  };

  const move = result.questions.move;
  if (move) {
    let criteria = move.criteria;
    if (profile.candidate_representation && criteria && typeof criteria === 'object') {
      criteria = Object.fromEntries(Object.entries(criteria).map(([id, value]) => {
        let representation = value;
        if (typeof value === 'string') {
          try { representation = JSON.parse(value); } catch { representation = { supplied_representation: value }; }
        }
        return [id, JSON.stringify({
          ...((representation && typeof representation === 'object' && !Array.isArray(representation)) ? representation : { supplied_representation: representation }),
          training_interpretation: profile.candidate_representation,
        })];
      }));
    }
    result.questions.move = {
      ...move,
      instructions: addGuidance(move.instructions ?? '', 'Offline training guidance (suggestive only; choose a supplied legal candidate ID)', profile.candidate_representation),
      criteria,
    };
  }
  return result;
}

export const activeTrainingProfile = loadTrainingProfile();
