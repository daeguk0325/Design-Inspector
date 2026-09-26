// Real-capture verification of the §9e contact-sheet path.
//
// The 4-arm run in style-facts-run.mjs used a hand-made 480x220 probe. The app
// does not send that: it sends a contact sheet (2 columns, 640px cells, numbered
// captions) PLUS an individual crop per selection. This script exercises that
// real path end to end against a real browser:
//
//   1. serves an app page that hosts the target in an IFRAME, on a separate
//      origin — the production topology
//   2. launches headless Chrome and drives it over CDP (ws, no new dependency)
//   3. injects the production Bridge artifact from the proxy's own
//      getInspectorBridgeArtifact() into the iframe's execution context
//   4. sends real app messages: HELLO, FREEZE, clicks, CAPTURE_SELECTION
//   5. feeds the real CaptureResultPayloads into the real buildContactSheet()
//   6. builds the real transmission prompt and sends it to the local model
//
// Two arms over the SAME facts, so the only variable is the real imagery:
//   E  facts only, no image        (text-only baseline)
//   F  facts + contact sheet + crops (the production payload)
//
// Run: npx vite-node scripts/capture-probe-e2e.mjs [--run]
//
// TRAP, learned the hard way: the target MUST be an iframe. The Bridge sends
// with window.parent.postMessage, so in a top-level test page window.parent ===
// window and the Bridge receives its own HELLO_ACK and SNAPSHOT, each bumping
// lastAppSequence and silently dropping the app's next command. The symptom is
// a FREEZE that is never acknowledged, with no error message. The Bridge is
// correct; a top-level harness is not.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import ts from 'typescript';
import { getInspectorBridgeArtifact } from './target-proxy.mjs';
import { buildTransmissionPrompt, DESIGN_INSPECTOR_SYSTEM_PROMPT } from '../src/ollama/client.ts';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ENDPOINT = 'http://localhost:11434';
const MODEL = 'hf.co/TaichuAI/ZDTaichu5.0-9B-GGUF:Q8_0';
const OUT = 'C:/Users/rlaeo/AppData/Local/Temp/opencode';
const RUN = process.argv.includes('--run');
const REQUEST = '이 버튼의 색상 대비가 충분한지 확인하고, 스페이싱을 정리해줘.';

const APP_PORT = 8731;
const TARGET_PORT = 8734;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const TARGET_ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;
const SELECTORS = ['checkout-cta', 'checkout-cancel', 'order-total'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serve(port, html) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function launchChrome(userDataDir) {
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
    `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(portFile)) {
      const [port] = (await readFile(portFile, 'utf8')).split('\n');
      if (port?.trim()) return { child, port: Number(port.trim()) };
    }
    await sleep(100);
  }
  child.kill();
  throw new Error('Chrome did not report a DevTools port');
}

/** Minimal CDP client, plus execution-context tracking so we can talk to the iframe. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 });
  const pending = new Map();
  const contexts = [];
  let nextId = 0;
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'Runtime.executionContextCreated') {
      contexts.push(message.params.context);
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      const gone = message.params.executionContextId;
      const at = contexts.findIndex((c) => c.id === gone);
      if (at >= 0) contexts.splice(at, 1);
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data ?? '')}`));
    else entry.resolve(message.result);
  });
  return {
    contexts,
    ready: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    send(method, params = {}, sessionId) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => socket.close(),
  };
}

async function evaluate(cdp, { expression, contextId, sessionId }) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}),
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}`);
  const targetHtml = await readFile(new URL('./capture-probe-target.html', import.meta.url), 'utf8');
  const appHtml = `<!doctype html><html><head><meta charset="utf-8"><title>App A</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe id="target" src="${TARGET_ORIGIN}/"></iframe></body></html>`;

  const appServer = await serve(APP_PORT, appHtml);
  const targetServer = await serve(TARGET_PORT, targetHtml);
  const userDataDir = join(tmpdir(), `di-capture-probe-${Date.now()}`);
  await mkdir(userDataDir, { recursive: true });
  const { child, port } = await launchChrome(userDataDir);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = connect(version.webSocketDebuggerUrl);
  await cdp.ready;

  let exitCode = 0;
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `${APP_ORIGIN}/` }, sessionId);

    // The app page and the iframe each get an execution context; the Bridge
    // lives in the iframe's.
    let appContextId = 0;
    let frameContextId = 0;
    for (let i = 0; i < 150; i += 1) {
      appContextId = cdp.contexts.find((c) => c.origin === APP_ORIGIN && !c.auxData?.isDefault === false)?.id ?? appContextId;
      const appCtx = cdp.contexts.find((c) => c.origin === APP_ORIGIN);
      const frameCtx = cdp.contexts.find((c) => c.origin === TARGET_ORIGIN);
      if (appCtx && frameCtx) { appContextId = appCtx.id; frameContextId = frameCtx.id; break; }
      await sleep(100);
    }
    if (!frameContextId) throw new Error(`iframe context never appeared; saw ${JSON.stringify(cdp.contexts.map((c) => c.origin))}`);
    console.log(`app context ${appContextId} (${APP_ORIGIN}), iframe context ${frameContextId} (${TARGET_ORIGIN})`);

    const artifact = await getInspectorBridgeArtifact(APP_ORIGIN);
    await evaluate(cdp, { sessionId, contextId: frameContextId, expression: `(function(){ ${artifact.scriptText}; return true; })()` });
    await sleep(700);
    const installed = await evaluate(cdp, { sessionId, contextId: frameContextId, expression: 'Boolean(window.__DESIGN_INSPECTOR_BRIDGE__)' });
    if (!installed) throw new Error('the Bridge did not install in the iframe');

    // Phase 1 (app context): handshake and freeze, across the frame boundary.
    await evaluate(cdp, {
      sessionId,
      contextId: appContextId,
      expression: `(() => {
        const frame = document.getElementById('target');
        const targetOrigin = ${JSON.stringify(TARGET_ORIGIN)};
        const received = [];
        window.addEventListener('message', (event) => {
          if (event.origin !== targetOrigin) return;
          if (event.data && typeof event.data === 'object' && typeof event.data.type === 'string') received.push(event.data);
        });
        window.__probe = { received, sequence: 0, connectionId: '', documentGeneration: '', frame, targetOrigin };
        return true;
      })()`,
    });

    const handshake = await evaluate(cdp, {
      sessionId,
      contextId: appContextId,
      expression: `(async () => {
        const p = window.__probe;
        const waitFor = async (type, timeoutMs, requestId) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            // Match on requestId when one is given, exactly as useBridge does.
            // Matching on type alone hands back the FIRST result of that type,
            // so a second capture request silently receives the first capture's
            // payload — which is what put component 1 in all three contact
            // sheet cells on the first run of this script.
            const hit = p.received.find((m) => m.type === type && (requestId === undefined || m.requestId === requestId));
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error('timed out waiting for ' + type + (requestId ? ' #' + requestId : '') +
            '; saw ' + JSON.stringify(p.received.map((m) => m.type + '#' + m.requestId)));
        };
        p.app = (type, payload) => {
          p.sequence += 1;
          const requestId = 'probe-' + p.sequence;
          p.frame.contentWindow.postMessage({
            protocolVersion: 1, type,
            connectionId: p.connectionId, documentGeneration: p.documentGeneration,
            requestId, sequence: p.sequence, payload: payload || {},
          }, p.targetOrigin);
          return requestId;
        };
        p.waitFor = waitFor;
        const helloId = p.app('VERA_INSPECTOR_HELLO', { appOrigin: ${JSON.stringify(APP_ORIGIN)} });
        const ack = await waitFor('VERA_INSPECTOR_HELLO_ACK', 8000, helloId);
        p.connectionId = ack.payload.bridgeConnectionId;
        p.documentGeneration = ack.payload.documentGeneration;
        const freezeId = p.app('VERA_INSPECTOR_FREEZE', { active: true });
        await waitFor('VERA_INSPECTOR_FREEZE_ACK', 8000, freezeId);
        return { connectionId: p.connectionId, documentGeneration: p.documentGeneration };
      })()`,
    });
    console.log(`handshake ok: ${handshake.connectionId}`);

    // Phase 2: click inside the target with REAL input events.
    //
    // The frozen Bridge listens in the capture phase on document, and a
    // synthetic element.dispatchEvent only runs the bubble phase from the
    // target, so it never reaches that listener. Input.dispatchMouseEvent
    // produces a trusted event through the full capture path, which is also
    // what a user's mouse does. The app cannot reach across the origin
    // boundary to click, exactly as in production.
    const frameRect = await evaluate(cdp, {
      sessionId,
      contextId: appContextId,
      expression: `(() => { const r = document.getElementById('target').getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    });
    await sleep(300);
    // Re-read after scrolling, since scrollIntoView moved things.
    const rectsAfter = await evaluate(cdp, {
      sessionId,
      contextId: frameContextId,
      expression: `(() => {
        const ids = ${JSON.stringify(SELECTORS)};
        return ids.map((testId) => {
          const r = document.querySelector('[data-testid="' + testId + '"]').getBoundingClientRect();
          return { testId, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
      })()`,
    });

    await cdp.send('Input.enable', {}, sessionId).catch(() => undefined);
    // Probe what actually reaches the frame, so a miss is diagnosable.
    await evaluate(cdp, {
      sessionId,
      contextId: frameContextId,
      expression: `(() => {
        window.__clickProbe = [];
        document.addEventListener('click', (e) => {
          window.__clickProbe.push({ target: e.target?.tagName + '#' + (e.target?.id || ''), trusted: e.isTrusted, x: e.clientX, y: e.clientY });
        }, { capture: true });
        return true;
      })()`,
    });
    const clicked = [];
    for (const point of rectsAfter) {
      const x = point.x + frameRect.x;
      const y = point.y + frameRect.y;
      const base = { x, y, button: 'left', clickCount: 1, buttons: 0 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base }, sessionId);
      await sleep(60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 }, sessionId);
      await sleep(40);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId);
      clicked.push(`${point.testId}@${Math.round(x)},${Math.round(y)}`);
      await sleep(220);
    }
    const clickProbe = await evaluate(cdp, {
      sessionId, contextId: frameContextId,
      expression: `JSON.stringify({ clicks: window.__clickProbe, state: window.__DESIGN_INSPECTOR_BRIDGE__.getState() })`,
    });
    console.log(`  frame saw: ${clickProbe}`);

    // Phase 3 (app context): collect the snapshot and request real captures.
    const probe = await evaluate(cdp, {
      sessionId,
      contextId: appContextId,
      expression: `(async () => {
        const p = window.__probe;
        // App state is folded from BOTH message types, exactly as useBridge
        // does: a click emits VERA_INSPECTOR_SELECTION (record + activeOrder)
        // and does not re-emit a snapshot, so the newest snapshot on the wire
        // can still be the empty post-freeze one.
        const byId = new Map();
        let activeOrder = [];
        for (const message of p.received) {
          if (message.type === 'VERA_INSPECTOR_SNAPSHOT') {
            byId.clear();
            for (const record of message.payload.selections) byId.set(record.selectionId, record);
            activeOrder = [...message.payload.activeOrder];
          } else if (message.type === 'VERA_INSPECTOR_SELECTION') {
            byId.set(message.payload.record.selectionId, message.payload.record);
            activeOrder = [...message.payload.activeOrder];
          }
        }
        if (activeOrder.length === 0) {
          throw new Error('no active selections; received ' + JSON.stringify([...new Set(p.received.map((m) => m.type))]));
        }
        const captures = {};
        for (const selectionId of activeOrder) {
          const captureId = p.app('VERA_INSPECTOR_CAPTURE_SELECTION', { selectionId });
          const result = await p.waitFor('VERA_INSPECTOR_CAPTURE_RESULT', 30000, captureId);
          captures[selectionId] = result.payload;
        }
        return {
          records: activeOrder.map((id) => byId.get(id)).filter(Boolean),
          activeOrder,
          captures,
          types: [...new Set(p.received.map((m) => m.type))],
        };
      })()`,
    });

    console.log(`clicked ${clicked.join(', ')} in the frame`);
    console.log(`bridge produced ${probe.records.length} selection records and ${Object.keys(probe.captures).length} captures\n`);

    const items = probe.activeOrder.map((selectionId, index) => {
      const record = probe.records.find((r) => r.selectionId === selectionId);
      return {
        selectionId,
        displayNumber: index + 1,
        component: record?.component ?? null,
        result: probe.captures[selectionId],
      };
    });

    for (const item of items) {
      const record = probe.records.find((r) => r.selectionId === item.selectionId);
      const facts = record?.styleFacts;
      console.log(`  (${item.displayNumber}) ${record?.elementKey}`);
      console.log(`      facts: ${facts ? JSON.stringify(facts.props) : '(none)'}`);
      if (facts?.geometry) console.log(`      geometry: ${facts.geometry.width}x${facts.geometry.height} at ${facts.geometry.x},${facts.geometry.y}`);
      console.log(`      capture: ${item.result.width}x${item.result.height} ${item.result.mimeType}, ${(item.result.base64.length / 1024).toFixed(0)}KB base64`);
    }

    // The contact sheet is built in the PAGE, because that is where the app
    // builds it: it needs a DOM canvas, which Node does not have. The real
    // buildContactSheet() is transpiled with the same approach the proxy uses
    // for the Bridge, so it is the production implementation and not a
    // re-implementation.
    const visualContextSource = await readFile(new URL('../src/ollama/visualContext.ts', import.meta.url), 'utf8');
    const visualContextJs = ts.transpileModule(visualContextSource, {
      fileName: 'visualContext.ts',
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    await evaluate(cdp, {
      sessionId,
      contextId: appContextId,
      expression: `(function(){ var m = { exports: {} }; var exports = m.exports; ${visualContextJs} window.__buildContactSheet = m.exports.buildContactSheet; return true; })()`,
    });
    const contactSheet = await evaluate(cdp, {
      sessionId,
      contextId: appContextId,
      expression: `(async () => await window.__buildContactSheet(${JSON.stringify(items)}))()`,
    });
    if (typeof contactSheet !== 'string' || contactSheet.length === 0) throw new Error('buildContactSheet returned nothing');
    await writeFile(join(OUT, 'probe-contact-sheet.jpg'), Buffer.from(contactSheet, 'base64'));
    const images = [contactSheet, ...items.map((i) => i.result.base64)];
    const imageKinds = ['contact-sheet', ...items.map(() => 'crop')];
    const totalKb = (images.reduce((n, i) => n + i.length, 0) / 1024).toFixed(0);
    console.log(`\n  contact sheet: ${(contactSheet.length / 1024).toFixed(0)}KB base64 -> probe-contact-sheet.jpg`);
    console.log(`  production payload: ${images.length} images (1 sheet + ${items.length} crops), ${totalKb}KB total`);
    console.log(`  app budget check: ${Number(totalKb) < 2800 ? 'within' : 'OVER'} the 2.8MB base64 budget`);

    const citations = probe.activeOrder.map((selectionId, index) => {
      const record = probe.records.find((r) => r.selectionId === selectionId);
      return {
        selectionId,
        elementKey: record.elementKey,
        component: record.component,
        file: record.file,
        line: record.line,
        mode: record.mode,
        displayNumber: index + 1,
        styleFacts: record.styleFacts,
      };
    });

    const arms = [
      { id: 'E', note: 'real facts, no image (text-only baseline over the same facts)', visual: undefined },
      { id: 'F', note: 'real facts + real contact sheet + real crops (production payload)', visual: { endpoint: ENDPOINT, model: MODEL, images, citationNumbers: [null, ...items.map((i) => i.displayNumber)], imageKinds, unavailableCitations: [] } },
    ];
    const results = [];
    for (const arm of arms) {
      const user = buildTransmissionPrompt(REQUEST, citations, arm.visual);
      await writeFile(join(OUT, `arm-${arm.id}.user.txt`), user, 'utf8');
      console.log(`\narm ${arm.id} — ${arm.note}`);
      console.log(`  prompt ${user.length} chars, images ${arm.visual ? images.length : 0}`);
      if (!RUN) continue;
      const started = Date.now();
      const res = await fetch(`${ENDPOINT}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: DESIGN_INSPECTOR_SYSTEM_PROMPT },
            { role: 'user', content: user, ...(arm.visual ? { images } : {}) },
          ],
          stream: false,
          options: { num_predict: 4000, temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const payload = await res.json();
      const text = payload.message?.content ?? '';
      await writeFile(join(OUT, `arm-${arm.id}.answer.md`), text, 'utf8');
      console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s, ${text.length} chars -> arm-${arm.id}.answer.md`);
      results.push({ id: arm.id, text });
    }
    if (results.length === 0) console.log('\n(dry run — pass --run to send to the model)');
    else await writeFile(join(OUT, 'probe-results.json'), JSON.stringify(results, null, 2), 'utf8');
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    exitCode = 1;
  } finally {
    cdp.close();
    child.kill();
    appServer.close();
    targetServer.close();
  }
  process.exit(exitCode);
}

main();
