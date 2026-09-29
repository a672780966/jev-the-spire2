import { mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { factoredDeliberate } from '../factored.mjs';
import { extractTrainingFacts, validateTrainingProfile } from '../training-profile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const runDirectory = resolve(repoRoot, '.private/spire-runs');
const trainingDirectory = resolve(repoRoot, '.private/spire-training');
const apiUrl = 'https://openrouter.ai/api/alpha/decisions';

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function text(value, max = 1200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function collectRunEvents(inputs = [runDirectory]) {
  const files = [];
  for (const input of inputs) {
    const absolute = resolve(input);
    let info;
    try { info = await stat(absolute); }
    catch { continue; }
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) if (entry.isFile() && extname(entry.name) === '.jsonl') files.push(join(absolute, entry.name));
    } else if (extname(absolute) === '.jsonl') files.push(absolute);
  }
  const events = [];
  for (const file of [...new Set(files)].sort()) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try { events.push({ ...JSON.parse(lines[index]), _source: file, _line: index + 1 }); }
      catch { /* A partial final line is ignored; the next run can be read again. */ }
    }
  }
  return events;
}

function safeCandidate(candidate) {
  const details = candidate.details ?? {};
  return {
    id: candidate.id,
    label: text(candidate.label, 180),
    command: candidate.command,
    plan: candidate.plan?.slice?.(0, 4) ?? undefined,
    forecast: candidate.forecast,
    details: Object.fromEntries(['description', 'card_description', 'target_type', 'category', 'price', 'gold_after_purchase', 'can_play']
      .filter(key => details[key] != null).map(key => [key, details[key]])),
  };
}

function extractCase(event, runOutcome, runEnd) {
  if (!event.state || !Array.isArray(event.candidates) || !event.candidates.length || !event.answer?.choice) return null;
  const ids = new Set(event.candidates.map(c => c.id));
  if (!ids.has(event.answer.choice) || !event.candidates.some(c => c.id === event.chosen?.id)) return null;
  return {
    sample_id: `${basename(event._source)}:${event._line}`,
    source: basename(event._source),
    line: event._line,
    reason: runOutcome === 'defeat' ? 'preceded a recorded defeat' : event.outcome,
    run_outcome: runOutcome,
    run_end: runEnd ? { outcome: runEnd.outcome, runsCompleted: runEnd.runsCompleted } : null,
    state: event.state,
    recent_memory: event.memory ?? null,
    jev: {
      choice_id: event.answer.choice,
      choice_label: event.chosen.label,
      confidence: event.answer.confidence ?? null,
      deliberation: event.deliberation ?? null,
      usage: event.usage ?? null,
    },
    candidates: event.candidates.map(safeCandidate),
  };
}

export function selectTrainingCases(events, limit = 6) {
  const bySource = new Map();
  for (const event of events) {
    const key = event._source ?? 'unknown';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(event);
  }
  const cases = new Map();
  const add = value => { if (value && !cases.has(value.sample_id)) cases.set(value.sample_id, value); };

  for (const sourceEvents of bySource.values()) {
    const sinceRunEnd = [];
    for (const event of sourceEvents) {
      if (event.kind === 'decision' && event.outcome === 'executed') sinceRunEnd.push(event);
      if (event.kind === 'decision' && ['game_rejected', 'stale_rejected'].includes(event.outcome)) add(extractCase(event, event.outcome, null));
      if (event.kind === 'run_end') {
        if (event.outcome === 'defeat') {
          for (const decision of sinceRunEnd.slice(-8)) add(extractCase(decision, 'defeat', event));
        }
        sinceRunEnd.length = 0;
      }
    }
  }

  const values = [...cases.values()].sort((a, b) => {
    const priority = item => item.run_outcome === 'defeat' ? 0 : ['game_rejected', 'stale_rejected'].includes(item.run_outcome) ? 1 : 2;
    return priority(a) - priority(b) || a.source.localeCompare(b.source) || a.line - b.line;
  });
  return values.slice(0, Math.max(1, Math.min(12, Number(limit) || 6)));
}

function lunaPrompt(cases) {
  return [
    'You are GPT-6 Luna, an offline training reviewer for Jev in Slay the Spire 2.',
    'Use only the supplied JSONL evidence and the explicit prior experiment summary below. Do not use tools, files, web, game control, named guides, or other outside knowledge.',
    'The goal is to improve Jev decision prompts after recorded mistakes. Distinguish observed facts from hypotheses. Do not claim a choice caused a later defeat unless the supplied evidence supports that link.',
    'Prior experiment conclusions supplied as context only: one verified A0 Ironclad win used 213 explicit Astra decisions; one continued A1 run ended in an Act 2 boss defeat; on six fixed A10 boss states, baseline planning won 0/6 while engine search found 4/6 winning lines, and a compressed experience profile reproduced wins on 12/12 replays of those already-seen states versus 2/12 without it. These are small, condition-specific experiments, not general win-rate evidence. Do not access or copy their source code. Treat this only as a reason to separate our own full-run outcomes from frozen-state replay results.',
    'Return one strict JSON object and no markdown with this exact shape:',
    JSON.stringify({
      schemaVersion: 'jev-training-proposal-v1',
      summary: 'brief evidence-based diagnosis',
      evidence: [{ sample_id: 'one supplied ID', observation: 'short evidence reference' }],
      training_profile: {
        schemaVersion: 'jev-offline-profile-v1', name: 'short name', strategy_context: 'text', state_fact_focus: 'text',
        state_facts: [{ key: 'short unique key', path: 'safe.visible.state.path[]', rationale: 'what the value helps Jev notice' }],
        factor_questions: { safe: 'text', progress: 'text', waste: 'text' },
        short_memory_guidance: 'text', candidate_representation: 'text',
      },
      candidate_changes: [{ sample_id: 'one supplied ID', choice_id: 'an ID from that sample candidates only', reason: 'evidence-based reason' }],
    }),
    'Limits: strategy_context 1200 chars; state_fact_focus 800; at most 6 state_facts; each state fact path must be relative to the top-level state object (do not prefix `state.`), dot-separated, and may use [] to flatten an array; factor question strings 600 each; short_memory_guidance and candidate_representation 800 each. Leave a field empty if evidence does not justify changing it.',
    'Candidate changes are diagnostic suggestions only. They cannot add or change legal action IDs, commands, or candidate membership. Never recommend using Luna during gameplay.',
    JSON.stringify({ cases }),
  ].join('\n\n');
}

async function askLuna(cases, outputDirectory) {
  const model = process.env.SPIRE_TRAINER_MODEL ?? 'gpt-6-luna';
  const tempDirectory = await import('node:fs/promises').then(fs => fs.mkdtemp(join(outputDirectory, 'luna-')));
  const output = join(tempDirectory, 'proposal.txt');
  const disabled = ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'view_image', 'image_generation', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'skill_search'];
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('codex', [
        'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', tempDirectory,
        '-c', 'web_search="disabled"', ...disabled.flatMap(feature => ['--disable', feature]),
        '-m', model, '-c', 'model_reasoning_effort="max"', '-o', output, '-',
      ], { stdio: ['pipe', 'ignore', 'ignore'] });
      const timeout = setTimeout(() => { child.kill(); rejectPromise(Error('Luna training review timed out.')); }, 180000);
      child.on('error', error => { clearTimeout(timeout); rejectPromise(error); });
      child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolvePromise() : rejectPromise(Error(`Luna training review exited with code ${code}.`)); });
      child.stdin.on('error', () => {});
      child.stdin.end(lunaPrompt(cases));
    });
    const response = (await readFile(output, 'utf8')).trim();
    if (!response || response.length > 24000) throw Error('Luna returned an empty or oversized training proposal.');
    return response;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function parseJsonResponse(response) {
  const clean = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = clean.indexOf('{'), last = clean.lastIndexOf('}');
  if (first < 0 || last < first) throw Error('Luna response did not contain a JSON proposal.');
  return JSON.parse(clean.slice(first, last + 1));
}

export function validateProposal(input, cases) {
  if (!input || input.schemaVersion !== 'jev-training-proposal-v1') throw Error('Luna proposal has the wrong schemaVersion.');
  const byId = new Map(cases.map(item => [item.sample_id, item]));
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).filter(item => byId.has(item?.sample_id)).map(item => ({
    sample_id: item.sample_id,
    observation: text(item.observation, 500),
  }));
  const rawProfile = validateTrainingProfile(input.training_profile);
  const rejected_state_facts = rawProfile.state_facts.filter(fact => !cases.some(sample => extractTrainingFacts(sample.state, { ...rawProfile, state_facts: [fact] }).length));
  const training_profile = validateTrainingProfile({ ...rawProfile, state_facts: rawProfile.state_facts.filter(fact => !rejected_state_facts.includes(fact)) });
  const candidate_changes = [];
  const rejected_candidate_changes = [];
  for (const change of Array.isArray(input.candidate_changes) ? input.candidate_changes : []) {
    const sample = byId.get(change?.sample_id);
    const candidate = sample?.candidates.find(item => item.id === change?.choice_id);
    if (!candidate) {
      rejected_candidate_changes.push({ sample_id: text(change?.sample_id, 120), choice_id: text(change?.choice_id, 120), reason: 'ID was not in that sample legal candidate set.' });
      continue;
    }
    candidate_changes.push({ sample_id: change.sample_id, choice_id: candidate.id, label: candidate.label, reason: text(change.reason, 500) });
  }
  return {
    schemaVersion: 'jev-training-proposal-v1',
    summary: text(input.summary, 1500),
    evidence,
    training_profile,
    rejected_state_facts: rejected_state_facts.map(fact => ({ key: fact.key, path: fact.path, reason: 'Path did not produce a visible value in any evidence sample.' })),
    candidate_changes,
    rejected_candidate_changes,
  };
}

function readApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const source = readFileSync(resolve(repoRoot, '.private/typesafe.cfg'), 'utf8');
    return source.match(/^api_key\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim() ?? '';
  } catch { return ''; }
}

async function askJev(payload, apiKey) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Jev replay returned HTTP ${response.status}.`);
  return response.json();
}

export async function compareJevOnRecordedCases(cases, profile, apiKey = readApiKey()) {
  if (!apiKey) throw Error('Missing TYPESAFE_API_KEY for the Jev recorded-state replay.');
  const results = [];
  for (const sample of cases) {
    const run = async trainingProfile => factoredDeliberate({
      state: sample.state,
      candidates: sample.candidates,
      recent: sample.recent_memory,
      trainingProfile,
      ask: payload => askJev(payload, apiKey),
    });
    const baseline = await run(null);
    const proposed = await run(profile);
    const selected = result => sample.candidates.find(candidate => candidate.id === result.answers?.move?.choice);
    const baselineChoice = selected(baseline), proposedChoice = selected(proposed);
    if (!baselineChoice || !proposedChoice) throw Error(`Jev replay returned an ID outside ${sample.sample_id}'s legal candidates.`);
    results.push({
      sample_id: sample.sample_id,
      run_outcome: sample.run_outcome,
      original_choice: { id: sample.jev.choice_id, label: sample.jev.choice_label },
      baseline_choice: { id: baselineChoice.id, label: baselineChoice.label },
      proposed_choice: { id: proposedChoice.id, label: proposedChoice.label },
      changed: baselineChoice.id !== proposedChoice.id,
      baseline_usage: baseline.usage ?? null,
      proposed_usage: proposed.usage ?? null,
    });
  }
  return results;
}

function markdownReport({ batchId, cases, proposal, replay, replayError }) {
  const rows = replay.map(item => `| ${item.sample_id} | ${item.run_outcome} | ${item.baseline_choice.label} | ${item.proposed_choice.label} | ${item.changed ? 'yes' : 'no'} |`);
  return [
    '# Offline Luna → Jev training batch', '',
    `Batch: \`${batchId}\``,
    `Evidence samples: ${cases.length}`,
    `Teacher: GPT-6 Luna (${process.env.SPIRE_TRAINER_MODEL ?? 'gpt-6-luna'}), isolated read-only call`,
    'Gameplay adviser: Jev only. This batch makes no game bridge requests.', '',
    '## Luna diagnosis', '',
    proposal.summary || '(No summary supplied.)', '',
    `Proposed profile: \`${batchId}/training-profile.json\`. It is saved for review and is not promoted automatically.`, '',
    proposal.rejected_state_facts?.length ? `Luna state-fact paths not present in the supplied states: ${proposal.rejected_state_facts.map(fact => `\`${fact.path}\``).join(', ')}.` : '',
    '## Jev recorded-state replay', '',
    replay.length ? '| Sample | Recorded outcome | Baseline Jev | Proposed profile | Choice changed? |\n|---|---|---|---|---|' : 'Replay was not completed.',
    ...rows,
    replayError ? `Replay status: ${replayError}` : '',
    '',
    'This replay compares Jev selections on frozen logged states. It does not estimate win rate and never sends a game action.', '',
  ].filter(Boolean).join('\n');
}

async function main(args) {
  await mkdir(trainingDirectory, { recursive: true, mode: 0o700 });
  const logInputs = args.flatMap((arg, index) => arg === '--log' && args[index + 1] ? [args[index + 1]] : []);
  const allEvents = await collectRunEvents(logInputs.length ? logInputs : [runDirectory]);
  const cases = selectTrainingCases(allEvents, argumentValue(args, '--cases', '6'));
  if (!cases.length) throw Error('No completed decisions tied to a defeat, rejected action, or stale state were found in the run logs.');
  const batchId = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDirectory = resolve(trainingDirectory, batchId);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(outputDirectory, 'evidence.json'), JSON.stringify({ schemaVersion: 'jev-training-evidence-v1', createdAt: new Date().toISOString(), cases }, null, 2), { mode: 0o600 });

  if (args.includes('--dry-run')) {
    await writeFile(join(outputDirectory, 'dry-run.json'), JSON.stringify({ sampleIds: cases.map(item => item.sample_id), note: 'No Luna or Jev calls were made.' }, null, 2), { mode: 0o600 });
    process.stdout.write(`Prepared ${cases.length} evidence samples in ${outputDirectory}; dry run made no model calls.\n`);
    return;
  }

  const lunaText = await askLuna(cases, trainingDirectory);
  const proposal = validateProposal(parseJsonResponse(lunaText), cases);
  await writeFile(join(outputDirectory, 'luna-proposal.json'), JSON.stringify(proposal, null, 2), { mode: 0o600 });
  await writeFile(join(outputDirectory, 'training-profile.json'), JSON.stringify(proposal.training_profile, null, 2), { mode: 0o600 });
  let replay = [], replayError = '';
  try { replay = await compareJevOnRecordedCases(cases, proposal.training_profile); }
  catch (error) { replayError = text(error.message, 500); }
  await writeFile(join(outputDirectory, 'jev-replay.json'), JSON.stringify({ results: replay, error: replayError || null }, null, 2), { mode: 0o600 });
  await writeFile(join(outputDirectory, 'report.md'), markdownReport({ batchId, cases, proposal, replay, replayError }), { mode: 0o600 });
  process.stdout.write(`Saved offline training batch to ${outputDirectory}. Evidence=${cases.length}, Jev replay comparisons=${replay.length}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
