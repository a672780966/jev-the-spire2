// Single-call factored decisions.
//
// deliberate() asks Jev 2-5 times in SERIES (assess, review, then conditional
// end-turn / merchant / card-order passes). Measured on a live run: p50 5.7s,
// max 30s, while one isolated call answers in ~300ms. The round trips are the
// cost, not the model.
//
// Jev evaluates every question in one request in parallel and in isolation, so
// questions are close to free. Measured on a captured combat state from
// .private/spire-runs, same state, same candidates:
//
//    1 question  -> 0.50s  7209 tokens  $0.000303
//   13 questions -> 0.81s  7979 tokens  $0.000335
//   25 questions -> 0.45s  8709 tokens  $0.000366
//   29 questions -> 0.54s  8953 tokens  $0.000376
//
// So we send ONE request carrying the broad `move` choice plus two narrow nouls
// per candidate, and combine them here, where the weights are ours to tune and
// the reasoning is inspectable in the decision log.
//
// This follows TypeSafe's own guidance: Jev is a System One model, so a judgment
// needing several independent factors is decomposed into several System One
// questions and recombined in code, rather than asked as one broad question.

import { decisionQuestion } from './planner.mjs';
import { compactRequest } from './compact-request.mjs';
import { activeTrainingProfile } from './training-profile.mjs';

export const FACTORED_VERSION = 'jev-single-call-factored-v1';

// A choice distribution over N candidates and an independent noul are not on the
// same scale: with 30 candidates the best `move` probability may be 0.20 while a
// noul sits at 0.95. Jev's documented failure mode 9 warns that a threshold
// tuned on one question type does not carry to another, so each signal is
// min-max normalised across the candidates before any of them are combined.
//
// Equal thirds because there is no labelled data yet to justify anything else.
// Weighting `move` above the others also double-counts survival, since the broad
// question already folds safety in, which let a pure-block line beat one that
// both survived and killed. To set these honestly, log decisions with the
// factors attached, label the runs that died, and fit the weights against that;
// until then an unequal split would be a guess wearing a number.
// `waste` is SUBTRACTED. It exists because the first version of this file scored
// 6/10 on the benchmark while the original policy's long review prose scored
// higher: every failure was a self-harm or dead-setup trap (Bloodletting on an
// empty hand, Fortifier, Pact's End). Those are a cost question, not a safety or
// progress question, so they need their own axis rather than more instruction
// text bolted onto the broad one.
// Swept 2026-09-23 over 14 configs on the 10 scored benchmark fixtures, then the
// two leaders re-run at n=100 each. Results, against the original multi-call
// `deliberate` policy measured on the same fixtures:
//
//   policy                    score      p50     calls
//   deliberate (original)     24/30      758ms   2.40
//   equal weights, waste 1/3  88/100     290ms   1.00
//   THIS (waste 1.0)          90/100     325ms   1.00
//
// waste at 1.0 makes the penalty a veto rather than a vote. It removes every
// self-harm failure (empty-hand Bloodletting, Fortifier), which the original
// policy still fails 3 times in 10. See ../SWEEP-FINDINGS.md, including the one
// fixture this loses on.
export const WEIGHTS = { move: 0.25, safe: 0.25, progress: 0.25, waste: 1 };

// Bounds the request. Every candidate always keeps its `move` probability; only
// the extra per-candidate nouls are capped, so nothing becomes unpickable.
//
// Was 28, which silently switched the factoring OFF on the most crowded boards.
// Measured on a live run: 6% of decisions exceeded it and 7% of all candidates
// received no factor questions at all. It cost a run. At 7 HP against three
// Inklets telegraphing 17 damage, the top three candidates came back
// `safe=None prog=None waste=None` with confidence 0, so the pick was decided by
// nothing, and the agent died two decisions later.
//
// Raising it is close to free. Same 53-candidate board, four samples each:
//
//   cap 10   31 questions  18236 tok  $0.000766  median 487ms
//   cap 28   85 questions  23096 tok  $0.000970  median 457ms
//   cap 53  160 questions  29846 tok  $0.001254  median 491ms
//
// 160 questions answer as fast as 31 because Jev evaluates them in parallel.
// 64 sits above the largest board observed (53) while leaving headroom under the
// 64k request context; raise it further only with a token measurement in hand.
const MAX_FACTORED_CANDIDATES = 64;

// A factor only gets a vote when it actually separated the candidates. Observed
// on the beckon-play fixture: safe spanned 0.07-0.13, progress 0.05-0.08, waste
// 0.80-0.87. Plain min-max stretches a 0.01 raw difference into a full 0-to-1
// swing, so a factor with no opinion ends up deciding the ranking on noise.
// Below DEADBAND of raw spread the factor returns neutral for everyone and
// contributes nothing.
export const DEADBAND = 0.15;

function normalise(values, deadband = DEADBAND) {
  const present = [...values.values()].filter(v => typeof v === 'number');
  if (!present.length) return new Map();
  const lo = Math.min(...present), hi = Math.max(...present);
  const span = hi - lo;
  if (span < deadband) return new Map([...values].map(([id, v]) => [id, typeof v !== 'number' ? null : 0.5]));
  return new Map([...values].map(([id, v]) =>
    [id, typeof v !== 'number' ? null : (v - lo) / span]));
}

export function factoredQuestion(state, candidates, { maxFactored = MAX_FACTORED_CANDIDATES, waste = true, trainingProfile = activeTrainingProfile, recent } = {}) {
  const profile = trainingProfile;
  const base = decisionQuestion(state, candidates, { trainingProfile: profile, recent });
  const factorQuestions = profile?.factor_questions ?? {};
  const factored = candidates.slice(0, maxFactored);
  const questions = { ...base.questions };
  for (const c of factored) {
    questions['safe_' + c.id] = { type: 'noul', instructions: {
      candidate: c.id,
      question: factorQuestions.safe || 'Given `state`, does taking the candidate identified by `candidate` leave the player able to survive the displayed incoming attack this turn? Answer no if it leaves lethal or near-lethal damage unblocked. Answer no if the candidate is not a legal action here.' } };
    questions['prog_' + c.id] = { type: 'noul', instructions: {
      candidate: c.id,
      question: factorQuestions.progress || 'Given `state`, does taking the candidate identified by `candidate` make real progress toward winning the run, such as securing a kill, applying a debuff that pays off, or spending energy efficiently? Answer no if it merely survives the turn without advancing.' } };
    if (waste) questions['waste_' + c.id] = { type: 'noul', instructions: {
      candidate: c.id,
      question: factorQuestions.waste || 'Given `state`, does the candidate identified by `candidate` pay a lasting cost whose payoff cannot actually be collected here? Costs include losing HP, exhausting or discarding cards, and spending energy on setup. Answer yes if the payoff needs a card, a target, an energy amount or a number of remaining turns that the visible state does not supply, or if it forgoes an available decisive play such as a kill. Answer no when the payoff is collectable now.' } };
  }
  return { ...base, questions };
}

// Combines the three signals into one ranking. Returns the full working so the
// decision log shows why a candidate won, not just that it did.
export function combine(candidates, answers, weights = WEIGHTS) {
  const move = answers.move;
  if (move?.type !== 'choice') throw new Error('Missing Jev move choice');
  const raw = new Map(), safe = new Map(), prog = new Map(), waste = new Map();
  for (const c of candidates) {
    raw.set(c.id, move.probabilities?.[c.id] ?? 0);
    safe.set(c.id, answers['safe_' + c.id]?.noul ?? null);
    prog.set(c.id, answers['prog_' + c.id]?.noul ?? null);
    waste.set(c.id, answers['waste_' + c.id]?.noul ?? null);
  }
  const nMove = normalise(raw), nSafe = normalise(safe), nProg = normalise(prog), nWaste = normalise(waste);
  const scored = candidates.map(c => {
    const parts = {
      move: (nMove.get(c.id) ?? 0) * weights.move,
      safe: (nSafe.get(c.id) ?? 0.5) * weights.safe,
      progress: (nProg.get(c.id) ?? 0.5) * weights.progress,
      waste: -(nWaste.get(c.id) ?? 0) * (weights.waste ?? 0),
    };
    return { id: c.id, label: c.label, parts,
      raw: { move: raw.get(c.id), safe: safe.get(c.id), progress: prog.get(c.id), waste: waste.get(c.id) },
      score: parts.move + parts.safe + parts.progress + parts.waste };
  }).sort((a, b) => b.score - a.score);

  // The waste penalty can push a score below zero, so shift to non-negative
  // before normalising or the distribution stops being one.
  const floor = Math.min(0, ...scored.map(s => s.score));
  const shifted = scored.map(s => s.score - floor + 1e-6);
  const total = shifted.reduce((sum, v) => sum + v, 0);
  const probabilities = Object.fromEntries(scored.map((s, i) =>
    [s.id, total > 0 ? Number((shifted[i] / total).toFixed(4)) : 1 / scored.length]));
  // Margin between first and second, not Jev's own confidence, which stays
  // under deliberation.jevMove so the two are never confused.
  const margin = scored.length > 1 ? scored[0].score - scored[1].score : 1;
  return { scored, probabilities, margin: Number(margin.toFixed(4)) };
}

export async function factoredDeliberate({ state, candidates, ask, onStage = () => {}, weights = WEIGHTS, maxFactored = MAX_FACTORED_CANDIDATES, trainingProfile = activeTrainingProfile, recent }) {
  if (candidates.length <= 1) {
    return { ...await ask(compactRequest(decisionQuestion(state, candidates, { trainingProfile, recent }))), deliberation: null };
  }
  onStage('Jev is scoring every option in one pass');
  const result = await ask(compactRequest(factoredQuestion(state, candidates, { maxFactored, waste: (weights.waste ?? 0) > 0, trainingProfile, recent })));
  const answers = result.answers ?? {};
  const { scored, probabilities, margin } = combine(candidates, answers, weights);
  const best = scored[0];
  if (!candidates.some(c => c.id === best.id)) throw new Error('Invalid factored choice');
  const jevMove = answers.move;
  return {
    ...result,
    answers: { ...answers, move: { type: 'choice', choice: best.id, probabilities, confidence: margin } },
    deliberation: {
      version: FACTORED_VERSION, calls: 1, weights, maxFactored,
      jevMove: { choice: jevMove.choice, confidence: jevMove.confidence },
      changed: jevMove.choice !== best.id,
      factorsAsked: Object.keys(answers).length - 1,
      ranking: scored.slice(0, 5),
    },
  };
}
