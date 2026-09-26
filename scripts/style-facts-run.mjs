// Sends the four §9e arms to a local Ollama model and records the result.
//
//   node scripts/style-facts-ab.mjs          build the arms from the real code path
//   node scripts/style-facts-run.mjs         send all four, write answers + results
//   node scripts/style-facts-run.mjs --eval-only   re-score saved answers, no inference
//
// Artifacts land in the temp dir; the recorded outcome is in
// docs/VERIFICATION_REPORT.md ("Live 9B A/B verification"). Kept in the repo so
// the result is reproducible rather than a one-off claim.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ENDPOINT = 'http://localhost:11434';
const MODEL = 'hf.co/TaichuAI/ZDTaichu5.0-9B-GGUF:Q8_0';
const OUT = 'C:/Users/rlaeo/AppData/Local/Temp/opencode';
const ARMS = ['A', 'B', 'C', 'D'];

const HEX = /#[0-9a-f]{3,8}\b/gi;
const KNOWN_COLOURS = new Set(['#1e1e1e', '#3884ff']);
const HEDGE = /확인\s*불가|알\s*수\s*없|판별\s*불가|확인할\s*수\s*없/;
const SECTIONS = ['## 디자이너 전달문', '## UI/UX 근거', '## 구체 구현 가이드', '## 검수 체크리스트'];

/**
 * A hedge is only a failure when it is attached to something we actually
 * measured. "확인 불가" about the *contrast ratio* is correct — a ratio cannot
 * be read off a hex pair without computing it, and the system prompt asks for
 * exactly that scoping. The first run flagged it anyway, which is why this
 * looks at the surrounding text instead of the whole answer.
 */
function hedgeContexts(text) {
  const out = [];
  for (const match of text.matchAll(new RegExp(HEDGE.source, 'g'))) {
    const start = Math.max(0, match.index - 60);
    out.push(text.slice(start, match.index + 20).replace(/\s+/g, ' ').trim());
  }
  return out;
}

const MEASURED_SUBJECT = /배경|색상|background|color|색|패딩|padding|간격|gap|폰트|font|라운드|radius/;
const UNMEASURED_SUBJECT = /대비\s*비율|contrast|비율|ratio|가독성|명도|WCAG/;

function hedgeOnMeasured(text) {
  return hedgeContexts(text).filter((context) => MEASURED_SUBJECT.test(context) && !UNMEASURED_SUBJECT.test(context));
}

function criteriaFor(id, text) {
  const found = [...new Set((text.match(HEX) ?? []).map((h) => h.toLowerCase()))];
  const invented = found.filter((h) => !KNOWN_COLOURS.has(h));
  const scopedHedges = hedgeOnMeasured(text);
  const checks = {
    A: {
      'mentions #1e1e1e': /#1e1e1e/i.test(text),
      'mentions #3884ff': /#3884ff/i.test(text),
      'mentions 12px': /\b12px\b/.test(text),
      'no hedge on a measured attribute': scopedHedges.length === 0,
      'invents no colour outside the facts': invented.length === 0,
    },
    B: {
      'recorded (control, no gate)': true,
      'hedged or estimated a colour': HEDGE.test(text) || found.length > 0,
    },
    C: {
      'all of arm A': /#1e1e1e/i.test(text) && /#3884ff/i.test(text) && /\b12px\b/.test(text),
      'no hedge on a measured attribute': scopedHedges.length === 0,
      'claims no background other than #3884ff': invented.length === 0,
    },
    D: {
      'section count': null,
      'sections beyond the required 1-2': null,
      'invents no colour outside the facts': invented.length === 0,
    },
  };
  const emittedPreview = /```design-inspector-preview/.test(text);
  const shared = { checks: checks[id], found, invented, scopedHedges, allHedges: hedgeContexts(text), emittedPreview };
  if (id === 'D') {
    const present = SECTIONS.filter((s) => text.includes(s));
    return { ...shared, present, beyond: present.filter((s) => s !== SECTIONS[0] && s !== SECTIONS[1]) };
  }
  return shared;
}

const results = [];
const EVAL_ONLY = process.argv.includes('--eval-only');

for (const id of ARMS) {
  const system = readFileSync(`${OUT}/arm-${id}.system.txt`, 'utf8');
  const user = readFileSync(`${OUT}/arm-${id}.user.txt`, 'utf8');
  const images = JSON.parse(readFileSync(`${OUT}/arm-${id}.images.json`, 'utf8'));
  const message = { role: 'user', content: user, ...(images.length > 0 ? { images } : {}) };

  if (EVAL_ONLY) {
    const answerPath = `${OUT}/arm-${id}.answer.md`;
    if (!existsSync(answerPath)) { console.log(`arm ${id}: no saved answer, skipping`); continue; }
    const text = readFileSync(answerPath, 'utf8');
    results.push({ id, ms: null, chars: text.length, evalCount: null, thinkingChars: 0, ...criteriaFor(id, text) });
    continue;
  }

  process.stdout.write(`arm ${id} … `);
  const started = Date.now();
  let payload;
  try {
    const res = await fetch(`${ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, message],
        stream: false,
        // Generous: this model emits a long thinking block first, and the first
        // run's 1200-token ceiling truncated arms C and D mid-thought, which
        // made them unmeasurable rather than wrong.
        options: { num_predict: 4000, temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    payload = await res.json();
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
    results.push({ id, error: String(error) });
    continue;
  }
  const ms = Date.now() - started;
  const text = payload?.message?.content ?? '';
  const thinking = payload?.message?.thinking ?? '';
  const evaluated = criteriaFor(id, text);
  writeFileSync(`${OUT}/arm-${id}.answer.md`, text, 'utf8');
  if (thinking) writeFileSync(`${OUT}/arm-${id}.thinking.txt`, thinking, 'utf8');
  console.log(`${(ms / 1000).toFixed(1)}s, ${text.length} chars, ${payload?.eval_count ?? '?'} tokens`);
  results.push({
    id,
    ms,
    chars: text.length,
    evalCount: payload?.eval_count ?? null,
    promptTokens: payload?.prompt_eval_count ?? null,
    thinkingChars: thinking.length,
    ...evaluated,
    text,
  });
}

writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2), 'utf8');

console.log('\n================ VERDICT ================');
for (const r of results) {
  if (r.error) { console.log(`\narm ${r.id}: ERROR ${r.error}`); continue; }
  const truncated = r.evalCount !== null && r.evalCount >= 4000;
  console.log(`\narm ${r.id} (${(r.ms / 1000).toFixed(1)}s, ${r.chars} chars, ${r.thinkingChars} thinking${truncated ? '  *** TRUNCATED - NOT MEASURABLE ***' : ''})`);
  for (const [name, value] of Object.entries(r.checks)) {
    const mark = value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO';
    const shown = Array.isArray(value) ? (value.length === 0 ? '(none)' : value.join(' | ')) : '';
    console.log(`  [${mark}] ${name}${shown ? `: ${shown}` : ''}`);
  }
  if (r.emittedPreview) console.log('  [INFO] emitted a design-inspector-preview block');
  for (const hedge of r.allHedges ?? []) console.log(`  [INFO] hedge context: …${hedge}`);
}
