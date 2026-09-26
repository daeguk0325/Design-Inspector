// Isolates one variable: does having measured style facts in context make the
// model emit a preview block on a request that is not a change request?
//
// Run: npx vite-node scripts/block-pressure.mjs
//
// Everything the 9B A/B could not separate. The arms there changed the request
// AND the presence of facts together, so a pass was ambiguous: it could mean
// the model follows the rule, or that my request was ambiguous enough to look
// like a change. This script holds the request fixed and moves only the facts.

import { DESIGN_INSPECTOR_SYSTEM_PROMPT, buildTransmissionPrompt } from '../src/ollama/client.ts';

const ENDPOINT = 'http://localhost:11434';
const MODEL = 'hf.co/TaichuAI/ZDTaichu5.0-9B-GGUF:Q8_0';
const RUN = process.argv.includes('--run');

const FACTS = {
  selectionId: 's1',
  elementKey: 'html:testid:checkout-cta',
  component: 'CheckoutCTA',
  file: 'src/Button.tsx',
  line: 10,
  mode: 'html',
  displayNumber: 1,
  styleFacts: {
    props: {
      color: 'rgb(30, 30, 30)',
      'background-color': 'rgb(56, 132, 255)',
      'font-size': '14px',
      'font-weight': '600',
      'padding-top': '12px',
      'padding-right': '16px',
      'padding-bottom': '12px',
      'padding-left': '16px',
      'border-radius': '8px',
    },
  },
};

// A handoff request. Nothing in it asks for a restyle, so a block is wrong.
const REQUEST = '지금 확인한 문제를 디자이너에게 전달해줘.';

const CASES = [
  { id: 'no-facts', user: REQUEST, expectedBlock: false },
  { id: 'with-facts', user: buildTransmissionPrompt(REQUEST, [FACTS]), expectedBlock: false },
  // Control: the same facts, but this one IS a change request.
  { id: 'facts+change', user: buildTransmissionPrompt('체크아웃 버튼 모서리를 4px로 줄여줘.', [FACTS]), expectedBlock: true },
];

for (const testCase of CASES) {
  const blocked = testCase.user.includes('design-inspector-preview');
  console.log(`\n${testCase.id}: prompt ${testCase.user.length} chars, block marker present: ${blocked}`);
  console.log(`  request: ${REQUEST === testCase.user ? REQUEST : '(a change request)'}`);
  console.log(`  expected a preview block: ${testCase.expectedBlock}`);
  if (!RUN) continue;
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: DESIGN_INSPECTOR_SYSTEM_PROMPT },
        { role: 'user', content: testCase.user },
      ],
      stream: false,
      options: { num_predict: 12000, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const payload = await res.json();
  const text = payload.message?.content ?? '';
  const emitted = text.includes('design-inspector-preview');
  const verdict = emitted === testCase.expectedBlock ? 'pass' : 'FAIL';
  console.log(
    `  ${((Date.now() - started) / 1000).toFixed(1)}s -> ${verdict} ` +
      `(emitted a block: ${emitted}, ${text.length} chars, ${(payload.message?.thinking ?? '').length} thinking)`,
  );
}
if (!RUN) console.log('\n(dry run — pass --run to send to the model)');
