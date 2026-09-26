# Verification Report — MVP + CSS preview

Date: 2026-09-26 (update: §9e style facts — measured DOM evidence in the
transmission prompt, sRGB colour normalization, named visual-transmission failure
reasons, `:cloud` disclosure).
Method: `npx tsc -b` (clean) + `npx vitest run` (37 files, 626 tests, all
passing) + `npm run lint` (0 errors; 12 pre-existing warnings) + `npm run build` +
real Vera/Launcher/Supervisor E2E + isolated Edge CDP crop/Ollama-payload E2E +
real-key composer E2E + a 4-arm A/B against a real local 9B vision model
(see "Live 9B A/B verification") + a real-capture run over the production contact-sheet + crop payload
(see "Live real-capture verification") + code-trace against the §20.15 and §23
checklists.
A real installed vision model remains a manual environment-specific follow-up for
the full capture path; the §9e prompt/evidence change is verified above.

## Automated results

| Category | Tests | Result |
|---|---|---|
| Protocol schema | `src/protocol/validate.test.ts` (44) | PASS — envelope, finite guards, version, unknown-type, handshake schema, stale connection/generation/sequence, selectionId, bounded capture assets, preview apply/undo/reset + session-reset + route + reselect-selection messages, origin/source helpers |
| Selection reconcile | `src/state/reconcile.test.ts` (6) | PASS — keep/drop-stale, null-snapshot, dedupe, numbering compaction, toggle-off exclusion, clear-all, first-added sort |
| Message + citation model | `src/state/models.test.ts` (19) | PASS — raw vs transmission separation, contact-sheet/crop mapping, citation-like raw text safety, pin-order reconstruction, preview transaction + decision fields |
| Export | `src/export/serialize.test.ts` (7) | PASS — latest request, active-only, dedupe, pin order, empty-constraints omission, deterministic extra/whitespace, purity (no AI) |
| Ollama streaming | `src/ollama/streamParser.test.ts` (5) | PASS — split objects, multi-object chunks, UTF-8 splits, malformed skip, done/error signals |
| Ollama request build | `src/ollama/client.test.ts` (10) | PASS — fixed English system role is first and requires Korean output; contact sheet + individual crops stay together in the final user message `images` array; preview system section; decision history injection |
| Markdown/LaTeX | `src/components/MarkdownMessage.test.tsx` (12) | PASS — GFM, hard breaks, fenced code, KaTeX, raw-HTML/image blocking, safe external links, plus a resolvable marker rendered as a chip, an unresolvable one left as text, markers inside fenced and inline code left literal, markers in a list and a table cell resolved, chip click re-selects, chip disabled with no handler |
| Split layout | `src/layout/split.test.ts` (7) | PASS — 25–60% clamp, pixel minimums, pointer delta (physical), ratio persistence, corruption recovery |
| URL/session | `src/url/policy.test.ts` (19) | PASS — full allow-list including 127/8 + rejections + material-difference rule |
| Persistence (schema v2) | `src/persistence/store.test.ts` (24) | PASS — round-trip, corruption recovery, v1→v2 migration, quota, streaming→interrupted, preview transaction + decision persistence |
| Freeze shortcut | `src/shortcut.test.ts` (6) | PASS — Ctrl/Cmd+Shift+F primary, Alt+Shift+F legacy, partial-chord rejection |
| Folder load | `src/target/folders.test.ts` (8) | PASS — project analysis, fallback scan, port probe order, self-port skip, handle memory |
| `?target=` handoff | `src/target/fromQuery.test.ts` (6) | PASS — canonical local URL parsing, remote rejection, token/legacy frame-param stripping |
| Supervisor status/proxy client | `src/supervisor/client.test.ts` (7) | PASS — status shaping, strict HTTP-loopback input, request generation, proxy POST/route validation, target/App origin isolation |
| Job contract | `scripts/jobfile.test.mjs` (10) | PASS — lenient parse (incl. double-encoded), injection rejection, dir/package.json checks, roundtrip, path resolution |
| Supervisor ports | `scripts/ports.test.mjs` (9) | PASS — preference-ordered diff, probe ok/refused, mid-wait appearance, timeout null, Vite/host/pinned log-port extraction, ignored ambient-port rejection |
| Supervisor core | `scripts/supervisor.test.mjs` (10) | PASS — canonical app URL building, job→status mapping (incl. stopped→idle, last.port fallback), backstop pid, taskkill args, browser open |
| Generic target proxy | `scripts/target-proxy.test.mjs` (16) | PASS — loopback policy, isolated 127/8 origin, XFO/multi-CSP + image-policy rewrite, request-origin blocking, cookie/redirect handling, streamed HTTP, bounded decompression, Bridge+capture artifact/CSP-hash injection, opt-out, WebSocket bytes/reset, 502 failure, port release, Bridge sources re-read when a fingerprint moves and the previous sources kept on a failed read |
| Model picker + vision | `src/ollama/models.test.ts` (13) | PASS — first-model auto-select, manual sentinel, saved-entry options, `/api/tags` lifecycle, `/api/show` vision/text/unknown capability |
| Citation marker | `src/citationMarker.test.ts` (12) | PASS — `({n})` shape, label fallback, splitting around one/several/adjacent markers, marker at either end, `우선순위 (1) 여백, (2) 대비` left alone, `{{ count }}` left alone, `{0}`/`({123})` rejected, no `lastIndex` carry-over between calls |
| Inline tags / editor units | `src/editor/attachments.test.tsx` (32) | PASS — attachment model, serialization (selectionId only, no image bytes), plain-text extraction, send lifecycle, keyboard intent, backspace arm state machine + controller, `AttachmentTag` rendering/armed/error/unknown-id, read-only chips |
| Controlled composer document | `src/editor/composerTyping.test.tsx` (22) | PASS — tags interleave with text in a **single block** at the caret, not at the front; a second tag lands beside the first without reordering it; no leading newline; a locally removed tag is restored when the authoritative list still contains it and dropped when it shrinks; visual placeholder hidden while tags exist; a held Backspace is never a confirmation and a drag that swallows a tag deletes it with no arm step; Ctrl+Z restores the tag and asks the target to re-select; long text keeps one block; adjacency resolves at either tag edge only; a reconcile that removes merges into one history entry and one that inserts does not |
| Plain text composition | `src/editor/plainText.test.ts` (10) | PASS — reference rendered where the tag was written, sentence order kept, spacing around words and between references, leading tags stay leading, name fallback before a number exists, unknown tag dropped, newlines preserved, typed-only text for the send gate |
| Composer lifecycle | `src/components/Composer.test.tsx` (11) | PASS — send gating, stop-instead-of-send, clears tags only on success, count is derived from the tag list alone (never a second counter), inline notice + tag restore when the target refuses the deselect, a tag is sent as `({1})` and never as its selection id, tags alone leave the gate shut |
| Chat list / decisions | `src/components/ChatList.test.tsx` (17) | PASS — each `({n})` rendered as an inline chip where it was written, no tag row under a user bubble, citation row kept on an assistant message, a marker in an answer becomes a chip that re-selects, an unresolvable marker left as text in both roles, parenthesised numbering left as text, no image bytes, element-key/file/mode fallbacks, empty request, raw copy, accept/revise/reject, preview status + undo affordance, empty state |
| Header (viewport, reset) | `src/components/Header.test.tsx` (7) | PASS — Desktop/Tablet/Mobile presets, reset-all-previews, bridge state display |
| Component details | `src/components/ComponentDetails.test.tsx` (15) | PASS — safe text rendering, style facts grouped under Color/Typography/Box/Layout/Motion in group order, hex swatches only (an `rgb()` value renders as text with no swatch), an injected label or `<img`-bearing value dropped rather than rendered, a property outside the allowlist renders no style section, existing detail rows unchanged |
| Style facts (Bridge) | `src/protocol/vera-inspector-style-facts.test.ts` (24) | PASS — per-property defaults omitted (`display:block`, `rgba(0,0,0,0)`), zero margin/border-width omitted while zero **padding** is kept, `oklch()` and `color(srgb …)` converted to `#rrggbb` through the canvas, a transparent paint reported as `transparent`, no canvas → value dropped rather than passed through, black-sentinel readback refused, 120-char cap + control-character stripping, viewport geometry + aria-label + 3-level ancestor chain stopping at `body` + tag name, non-allowlisted property never emitted. Every test stubs `getComputedStyle`: jsdom returns `''` for most longhands, so an unstubbed test would pass while measuring nothing |
| Style facts (app) | `src/style/sanitize.test.ts` (23) | PASS — unknown property or top-level key refuses the whole record, control characters stripped and values bounded, malformed geometry/ancestors rejected, fractional geometry rounded, per-record storage budget enforced, citation-marked prompt block with four→one and symmetric-pair box collapsing, zero padding omitted from `box=`, a label reading like an instruction kept as inert quoted data, over-budget records drop whole groups (colour survives, motion does not) and still emit the marker |
| Style facts (wire) | `src/protocol/validate.test.ts` (+11, 56 total) | PASS — partial key set accepted (`hasExactKeys` would reject it, since the Bridge omits defaults), unknown property incl. `__proto__`/`constructor` rejected, 120-char value bound enforced on both sides, 57 properties rejected, unknown top-level key rejected, manipulated `props` container rejected, geometry missing/extra/negative/fractional/string rejected, over-long label and malformed tag name rejected, ancestor chain over 3 or non-`tag[.class]` rejected |
| Style facts (end to end) | `src/protocol/vera-inspector-bridge-runtime.test.ts` (+3, 33 total) | PASS — facts on a real `VERA_INSPECTOR_SELECTION` payload pass `contractFailures()`, i.e. the app-side validator accepts what the Bridge emits; facts dropped on a route change with no cache to go stale; omitted for a non-HTML mode |
| Transmission prompt | `src/ollama/client.test.ts` (+12, 21 total) | PASS — facts block present with **and** without an image, placed before the image block, per-record `({n})` numbering in order, omitted when no citation carries facts, an injected value stays inside the fenced evidence block and never becomes a section header, cloud forwarding disclosed exactly once and never mentioned for a local model, the no-image fact stated once rather than per citation, narrow-question focus routing with keyword dedupe, user request still last |
| Export isolation | `src/export/serialize.test.ts` (+1, 8 total) | PASS — measured style values, labels and the `styleFacts` key never reach the copyable agent prompt |
| Bridge hook | `src/hooks/useBridge.test.ts` (16) | PASS — handshake retry, nonpersisted session binding, fresh-snapshot gate, handshake recovery, session reset, capture correlation, route epoch, preview request correlation, confirmed deselect (resolves true on a snapshot without the selection, false on timeout or when not ready), reselect posts the command and the tray follows the bridge's echoed record |
| Chat hook | `src/hooks/useChat.test.ts` (13) | PASS — sanitized streaming, sidecar extraction, preview callback on clean completion, the request citations stored on the answer (and on a retried answer) so its markers resolve, stop/retry/interruption, late-token session guard |
| Preview CSS policy | `src/preview/cssPolicy.test.ts` (18) | PASS — visual-only allowlist, denied display/flex/grid, denied javascript:/url(), value bounds, per-rule cap |
| Preview contract | `src/preview/contract.test.ts` (15) | PASS — selectorId mapping, declaration normalization, multi-target payloads, invalid shape rejection |
| Preview sidecar parser | `src/preview/sidecar.test.ts` (25) | PASS — split tokens, tagged block extraction, truncation, oversized, non-JSON, multi-block, stray text |
| Preview controller | `src/preview/controller.test.tsx` (59) | PASS — auto apply on clean completion, skip on error/stop/disabled, atomic multi-layer, Undo, Reset, duplicate suppression, decision persistence, route rebind (unbound/ambiguous), suspend while disabled |
| Bridge preview runtime | `src/protocol/vera-inspector-bridge-runtime.test.ts` (30) | PASS — style layer add/remove, anchor rebind, route epoch, session reset, runtime only (no source write), reselect re-activates a deselected record under the same id, ignores an unknown id, and declines a record whose element left the page |
| Capture hardening | `src/protocol/vera-inspector-capture.test.ts` (8) | PASS — queue, timeout, safe error codes, modern-CSS sanitized retry, SVG/canvas direct raster, metadata-only fallback |

## Live E2E evidence (real processes, 2026-09-26)

- App A `127.0.0.1:5173`, Supervisor status/control `127.0.0.1:5199`, target
  fixture on `127.0.0.1:3000` served through one isolated 127/8 proxy route with
  the compatibility Bridge injected (CSP hash applied, target file untouched).
  The target's selection overlay is a shadow-DOM host, so selection state is
  read from `.vi-sel` / `.vi-label` inside it.
- **Real-keystroke composer run (Edge + CDP, focus emulation on):**
  - Selected two real target components → 2 inline tags rendered with thumbnail,
    number, name, `ⓘ`, `×`.
  - Clicked immediately to the right of the last tag and typed
    `make this roomier`: **tags stayed at 2**, the editable still had exactly
    **one block**, the typed text rendered **on the same visual row as the tags**
    (tag `top=759` vs text `top=763`), the visual placeholder was **absent**
    (`aria-placeholder` retained for a11y), and Send became enabled.
  - Typed ~200 more characters: the text wrapped, the block count stayed **1**,
    and the tags stayed on the first row (`sameLineAsTags: true`).
  - `Home` moved the caret into the pinned region; the clamp pushed it back out
    to the tag boundary, and the typed text was **not** deleted.
  - First `Backspace` at the boundary armed the tag (`data-armed="true"`) and
    deleted nothing; the second removed it. Tag count 2 → 1, the placeholder
    count followed to `Ask about 1 selected element…`, and the target overlay
    dropped from **2 selection boxes to 1** with the label renumbered to `1` —
    i.e. the component really was deselected in the inspected page.
  - The `×` control removed the last tag: composer placeholder returned to the
    generic `Freeze the target, select elements…`, and the target overlay fell to
    **0 selection boxes** — no stale "still selected" state remained.
  - Re-selected one component, typed, and sent: the composer cleared (tags 0,
    text empty), the request carried **2 images** (contact sheet + crop), and the
    tag→chat hand-off animation was observed on screen for ~300 ms
    (`.attach-fly` present in samples from 240 ms to 540 ms) before removing
    itself.
- **Inline interleave and inline references** (isolated Edge CDP, real
  keystrokes and a real drag):
  - Typing `make this roomier` and then clicking a component put the tag **after
    the sentence** (`["text:make this roomier", "tag:sel-…"]`), and clicking a
    second component after ` please` produced
    `["text:make this roomier", "tag:sel-…", "text: please", "tag:sel-…"]` — the
    tags are interleaved rather than pinned to the front.
  - The transmitted `User request:` was `make this roomier ({1}) please ({2})`.
  - The user bubble rendered **2 inline chips** (numbers `1`,`2`, names
    `button`,`button`) and **0** tag rows; the bubble text read
    `make this roomier 1button please 2button`.
  - The placeholder and the caret line measured `800` vs `801` (delta **1px**,
    previously a full `1em` margin below) and the composer paragraph computed
    `margin-top: 0px`.
  - Holding Backspace for six auto-repeats deleted seven characters
    (`abcdefgh` → `a`).
  - A drag from the start of the sentence to the end removed the tag and the
    words in one keystroke with no arm step, and the target overlay went
    **1 → 0** boxes.
  - `Ctrl+Z` brought the tag back **in place** and the target overlay returned to
    **1** box, with `VERA_INSPECTOR_RESELECT_SELECTION` observed on the wire.
- **Answer-side citation chips** (isolated Edge CDP):
  - A request carrying a tag was sent as `({1}) make it roomier`.
  - The answer — which cited `({1})` twice in prose and once inside an inline
    code span — rendered **2 chips** (both number `1`, both `button`), kept the
    code span literal, and grew a **citation row with 1 chip**. Exactly one
    literal marker survived in the rendered text, and it was the code one.
  - The target was clear after the send (**0 boxes**); clicking the answer's chip
    brought it back to **1 box labelled `1`** and returned the component to the
    composer tray.
- Process note: the first reselect attempt appeared to fail. The cause was the
  dev target proxy reading the Bridge source once per process, so a proxy started
  before the handler was added kept serving the old Bridge. The loader now
  fingerprints the sources and reloads on change; restarting the launcher was
  enough to confirm the behaviour.
- Split-direction check: dragging the divider toward the right grew the
  **target** (`836 → 955.25px`) and shrank chat (`558 → 438.75px`); pointer and
  keyboard both updated ARIA.
- CSS preview E2E: a CDP-injected structured `design-inspector-preview` block on
  a clean completion made the target's secondary button render
  `padding-top: 24px` and background `rgb(255, 0, 0)` **at runtime only**; the
  fixture's source SHA-256 was identical before and after. SPA navigation
  re-resolved the strong anchor and the preview persisted; `Undo` restored the
  original padding/background; `Reset` removed all layers; an `accepted`
  decision and the `undone` transaction survived a page reload.
- Same-target session isolation: a new session reset the Bridge
  selection/capture/preview state (0 tags, 0 messages) and still reported
  `Connected`; nothing leaked.
- The proxy and status API returned 403 to a foreign Origin; the proxy returned
  `forbidden-request` for a forged cross-site Fetch Metadata request; a stale
  lower-generation route mutation was rejected with 400. All processes were
  stopped at the end of the run.

## Checklist trace (§20.15 required behavior)

- No hover/interception while OFF; listeners iframe-only + frozen-only; unfreeze
  restores Vera behavior → bridge `attach`/`detach` + `setFrozen` reset.
- Citations only from `VERA_INSPECTOR_SELECTION`; App A never mints IDs
  (`missing-selection-id` rejection tested; no `uid('sel')` in `src/`).
- Launcher handoff, deterministic default/stored target activation, normal
  pre-freeze interaction, dual-context `Ctrl+Shift+F` (legacy `Alt+Shift+F`
  retained), Bridge-confirmed freeze badge, liveness badge, reconnect
  reconciliation, mode-disabled-while-live, dashed hover, solid+numbered
  selection, per-`selectionId` tracking, stable `elementKey`, tray/export
  number parity, highlight removal on remove/clear-all, same-ID toggle,
  freeze-OFF export clearing with history intact → implemented per code trace.
- Copy/Pin per message, persisted pin order, session CRUD + bulk delete with
  confirm, `+ New session`, reload persistence, zero-session state, model
  discovery + manual fallback, model precedence, real chat-capability test,
  incremental streaming, safe JSON parsing, Stop/Retry/interruption states,
  inline errors, transmission-time citation embedding with clean raw
  persistence → implemented per code trace.
- `Copy for Agent` AI-free, latest-request/active-only/deduped/pinned-constraints
  + raw-transcript separation → tested.
- Assistant Markdown/LaTeX/code, assistant bubble containment, 40% default
  resizable split (physical direction), keyboard separator semantics, inline
  atomic component tags pinned to the front of a single-block composer,
  double-backspace delete that deselects in the target, component crop capture,
  Vision capability guard, contact-sheet + individual-crop transmission, and
  auto CSS preview (apply / undo / reset / route-rebind / session-isolation) →
  automated and isolated-browser verified.
- Integration checklist completeness (Zustand, HTML/3D/Konva, no hidden steps) →
  `docs/MANUAL_INTEGRATION_CHECKLIST.md` written.

## §23 architectural checks

Single live-state owner (Bridge), full-snapshot handshake, reconcile-before-
export, generation-gated staleness, history survival, Bridge-only IDs, stable
elementKey (no ref-equality dependence), explicit ordering semantics, exact
origins, source checks, schema validation, reconnect reconciliation, liveness
expiry, dual-context shortcut, interception + restoration, canonical freeze-OFF
clear, session/URL leak guards, chat-capability test, bounded context, guarded
streaming races, deterministic AI-free export, allow-listed runtime-only CSS
preview with per-transaction undo — all implemented and covered by tests.


## Live 9B A/B verification (§9e measured evidence, 2026-09-26)

Executed against a real local model, not a mock.

- Model: `hf.co/TaichuAI/ZDTaichu5.0-9B-GGUF:Q8_0`, `capabilities: [tools, thinking, completion, vision]`
- Harness: `scripts/style-facts-ab.mjs` builds the arms from the **real** `buildTransmissionPrompt` and `DESIGN_INSPECTOR_SYSTEM_PROMPT`; `scripts/style-facts-run.mjs` sends them and evaluates mechanically
- Request: `이 버튼의 색상 대비가 충분한지 확인하고, 스페이싱을 정리해줘.`
- Facts: `box=12px 16px  radius=8px  color=#1e1e1e  bg=#3884ff  font=600 14px/1.55 Pretendard`, `at 24,180 120x40`, `style=display:inline-flex, align-items:center, gap:8px`
- Image: `vision-probe.png`, 480×220
- `temperature: 0`, `num_predict: 4000`

Each arm differs from its pair in exactly one variable, and the pass criteria were
declared before any inference ran.

| Arm | system prompt | facts | image | Result |
|---|---|---|---|---|
| A | new | yes | no | **5/5 PASS** — 15.2s, 326 chars |
| B | new | no | yes | control, failure mode reproduced — 15.1s, 307 chars |
| C | new | yes | yes | **3/3 PASS** — 28.2s, 548 chars |
| D | pre-§9e (verbatim) | yes | no | mixed — 23.0s, 1154 chars |

### A vs B — the §9e claim, confirmed

The image alone yielded **nothing**. Arm B extracted zero hex values and zero px
values from a 480×220 crop and answered `background-color: 확인 불가 (측정값 없음)`.
Arm A, given the same evidence as text, produced all of `#3884ff`, `#1e1e1e`,
`12px × 16px`, `8px` and invented no colour outside the facts. This is the exact
failure the feature set out to remove.

Arm B also emitted a machine block containing a non-CSS string:

```design-inspector-preview
{"version":1,"rules":[{"target":1,"declarations":{"background-color":"확인 불가"}}]}
```

`isCssValueValid` rejects it, so it is a no-op rather than a corrupted preview —
but it shows the model will fill a machine block it has no evidence for.

### C vs A — measurements hold against the image

With the image attached, the model still answered from the measurements: same
hex pair, same `12px 16px`, same `8px`, and `14px` (the measured font size). No
other background was claimed. The "if a number conflicts with an image, follow the
number" rule did not need to fire, because the image was too small to offer a
competing value — this arm shows the image does not *distract*, not that the
conflict clause is exercised.

### A vs D — the prompt rewrite, honestly mixed

| | A (new) | D (pre-§9e) |
|---|---|---|
| sections emitted | 3 | 4 |
| length | 326 chars | 1154 chars (3.5×) |
| values not in the facts | none | `24px`, `gap: 12px` |
| raw ```css block | no | yes |
| claim about contrast | `확인 불가` (scoped, correct) | "충분할 것으로 판단됩니다" (unmeasured) |

The rewrite removed the invented values, removed the fabricated WCAG claim, and
cut the length by 3.5×. **It did not achieve the stated goal of 1–2 sections for
a narrow question** — 4 became 3, and §3 survived as a restatement of the
measured values (`box: 12px 16px`, `gap: 8px`) rather than guidance. That
instruction is not doing what it claims and should be revisited.

Arm A's single use of "확인 불가" was correctly scoped to the contrast **ratio**,
which genuinely cannot be read off a hex pair without computing it. The first run
of this verification flagged it as a failure; the criterion was wrong, not the
model, and was corrected to test whether a hedge is attached to a *measured*
attribute. Recorded here because the correction is part of the result.

### Two methodology errors found and fixed during this run

1. `num_predict: 1200` truncated arms C and D mid-`thinking` — arm C returned
   **zero characters**. Both were unmeasurable, not wrong. All four arms were
   re-run at 4000.
2. The hedge criterion flagged any occurrence of "확인 불가" anywhere in the
   answer, which fails the correctly-scoped use the system prompt explicitly asks
   for. Narrowed to hedges adjacent to a measured attribute.

### Known artifact

Arm C's §2 restated the raw facts line nearly verbatim, including
`label="주문하기"` and the ancestor chain. The model can parrot the evidence block
instead of interpreting it. Acceptable at 9B; worth watching at larger sizes.

### Limitation of this verification

It validates the **prompt and evidence change**, not the capture path. The app
sends a contact sheet (640px cells) plus individual crops under a 2.8M base64
budget; this probe is a single 480×220 / 2.6 KB image. Capture itself is covered
by the existing E2E evidence above.

## Live real-capture verification (§9e production payload, 2026-09-26)

The 4-arm run above used a hand-made 480×220 probe. The app does not send that: it
sends a **contact sheet** (2 columns, 640px cells, numbered captions) plus an
individual crop per selection, all from real html2canvas captures. That path is
verified here against a real browser.

Harness: `scripts/capture-probe-e2e.mjs` + `scripts/capture-probe-target.html`.

- Chrome (headless) driven over CDP via `ws`; no new dependency
- The target is served in an **iframe** on a separate origin, the production
  topology
- The Bridge is injected using the proxy's own
  `getInspectorBridgeArtifact()` — the real bridge, the real html2canvas
  capture, the real `collectStyleFacts`
- The contact sheet is built by the real `buildContactSheet()`, transpiled the
  same way the proxy transpiles the Bridge, and run **in the page** because it
  needs a DOM canvas
- Clicks are real `Input.dispatchMouseEvent`, not synthetic events
- 3 components: a filled button, a ghost button, and a text node

Real measurements that came back, e.g. the ghost button:

```
color rgb(56,132,255) · background transparent · padding 10px 14px
border 1px solid · radius 6px · display flex · align-items center · gap 8px
geometry 56x42 at 141,144 · capture 112x84 PNG
```

Payload actually sent: **4 images, 46KB total** (30KB sheet + 3 crops), well
inside the 2.8MB budget.

### Three defects this found that the jsdom fixtures could not

**1. The default table was wrong, and ~40% of every record was noise.** The
fixtures fed exact values, so a wrong default looked right. Against a real page:

- `fill`/`stroke` have CSS initial value `black`, not `none` — so every HTML
  element reported `fill: rgb(0, 0, 0)`
- `transition-duration: 0s` was reported on every element (initial is `0s`)
- `word-spacing: 0px` likewise
- `border-*-color`, `outline-color` and `caret-color` have initial value
  `currentColor`, so getComputedStyle resolves them to the element's own text
  colour. All six were echoing `color` on every element.

Fixed by correcting the initial values and dropping currentColor echoes.
Records went from **23 / 27 / 18** properties to **16 / 21 / 12**, and every
remaining property is informative. Documented trade-off: when an author sets a
border to exactly the text colour, the rule drops it as indistinguishable from
the echo. Computed style cannot tell cause from coincidence; the width and style
are still reported, and the colour is recoverable from `color`.

**2. Filtering `rgba(0,0,0,0)` manufactured a gap in the evidence.** The earlier
review argued a transparent background is noise on every element and should be
omitted. Against a real page the model then had to answer:

> **버튼 2 배경색 확인 불가**

for a ghost button whose background was plainly knowable. The filter created the
very uncertainty the feature exists to remove. `background-color` is no longer
treated as a default; the model now writes `배경 투명` and the false gap is gone.
The original judgement that it was noise was wrong, and only a real run could
show it.

**3. The facts' display shorthand leaked into the machine block.** `box=12px 16px`
in the facts was read as a declaration key:

```design-inspector-preview
{"version":1,"rules":[{"target":2,"declarations":{"color":"rgb(255,255,255)","box":"12px 16px"}}]}
```

`validatePreviewBlock` rejected the whole rule as `unknown-property: box` — the
safety net held and nothing corrupted — but the cost is real: **one bad key
discards the valid declarations beside it**, including a correct colour fix. The
system prompt now states that the facts tokens are display shorthand, not CSS
property names, and maps them (`box -> padding`, `radius -> border-radius`, …).
After the fix the model emits `padding` and `gap` instead of `box`.

A residual echo remains in prose ("패딩을 `box=12px 16px`로 설정합니다"), which is
harmless — it is a label in a sentence, not a machine key.

### Result: the production payload does not degrade the facts

| | E — facts only | F — facts + sheet + crops |
|---|---|---|
| components attributed correctly | 3/3 | 3/3 |
| invented colours | none | none |
| false "확인 불가" | none (after fix 2) | none |
| remaining hedge | contrast **ratio** only | none |
| preview block | rejected (`gap` is forbidden) | **valid, would auto-apply** |

Both arms read the measurements, not the image. F's block applies
`padding: 12px 16px`, `border-radius: 8px`, `background-color: rgb(56,132,255)`,
`color: rgb(30,30,30)` — every value measured, every property inside the
visual-only allowlist. E's block proposed `gap`, a layout property the preview
policy deliberately refuses, and was discarded cleanly.

The one claim neither arm could make is the contrast **ratio**, which is correct
behaviour: a ratio is not a thing you read off a hex pair, you compute it.

### Two harness traps, recorded so they are not repeated

- **The target must be an iframe.** The Bridge sends with
  `window.parent.postMessage`, so in a top-level test page `window.parent ===
  window` and the Bridge receives its own HELLO_ACK and SNAPSHOT. Each bumps
  `lastAppSequence` and silently drops the app's next command. The symptom is a
  FREEZE that is never acknowledged, with no error message. The Bridge is
  correct; a top-level harness is not.
- **Match responses by `requestId`, never by type alone.** Matching on type
  returns the *first* result of that type, so the second and third capture
  requests silently received the first capture's payload. All three contact
  sheet cells showed component 1. `useBridge` keys pending captures by
  `requestId` for exactly this reason.


## Manual follow-up (needs a running inspected app + Ollama)

A. Freeze → iframe reload → reconnect → reconciliation
B. React remount reselect identity
C. Send with a real installed Ollama Vision model → inspect image-token cost and
   response quality (and observe a real model emitting a valid preview block).
   Partially covered by the 4-arm run above; still open for the real contact-sheet
   + crop payloads, which that run did not exercise.
D. Freeze OFF export clearing
G/H. Stop/Retry/session-switch races against a live model
I. Context-limit behavior
K. Ctrl+C in the supervisor console → target port stops answering (coupled shutdown)
K2. Target crash → in-window error + retry restarts it
L. `start-inspector.bat` double-click cold start
Plus visual QA pass (§20.14) in a real browser.

## Known limitations

1. R3F/Konva hit-testing depends on Vera registering `getHits` callbacks;
   without registration, mode clicks yield explicit unavailable-metadata
   citations (by design, never fabricated).
2. HTML `file:line` is authoritative only where Vera adds
   `data-inspector-*` attributes or a build plugin; otherwise explicit fallback.
3. Multi-tab is last-write-wins (documented) — concurrent editors may overwrite
   each other's session list; live state always re-reconciles.
4. The governing `Design_Inspector_Tool_BUILD_PROMPT_v4.2.md` file was absent
   from the workspace; the supplied v4.3 brief text was used as the contract.
   No spec file was modified.
5. The App A URL field and folder picker were intentionally removed. New target
   processes are launched through the Launcher; App A reuses the deterministic
   default or stored sessions. The iframe-side Freeze chord remains attached at
   init and works while Live (§9.1).
6. Freeze chord changed from `Alt+Shift+F` to `Ctrl+Shift+F` (`Cmd+Shift+F`
   on macOS) at user request — Windows reserves `Alt+Shift` for language
   switching and Chrome swallows several `Alt+Shift` chords. `Alt+Shift+F`
   still works as legacy fallback in both contexts.
7. Visual component context requires a local Ollama endpoint and a model that
   advertises vision; remote endpoints and `:cloud` models are blocked before
   capture transmission. Unknown legacy capabilities are allowed through to
   local Ollama. Raw crop bytes are memory-only, retry-budgeted, and not
   restored after an app reload.
8. Naming: new surfaces (Launcher, supervisor, job file, `?target=`, docs)
   use generic "target project / inspected app" language. `VERA_INSPECTOR_*`
   wire-protocol constants and the installed-bridge filename are frozen for
   compatibility; "Vera" remains only as the example project name.
9. Launcher binary is Windows-only for now (`-win_x64.exe` in
   `launcher/dist/`); mac/Linux binaries deferred per scope decision.
10. Icons: `scripts/make-icon.mjs` (pure-Node) generates `icon.png` +
    `app-icon.svg` from one geometry; App A favicon switched to the new mark.
11. Launcher drag: declarative `setDraggableRegion` proved unreliable, replaced
    with pointer-driven `window.move`/`getPosition` (buttons excluded).
    Verified headlessly: commanded (+80,+60) move measured exactly via
    GetWindowRect. Real-mouse glide is manual QA.
12. Launcher port diagnostics: target log chunks are buffered across Neutralino
    events, explicit port announcements can be sniffed for off-list ports, and
    process exit / occupied-port / timeout cases identify the failure in the
    launcher error state. `scripts/ports.test.mjs` covers the parser suite; the
full repository currently passes 626 tests across 37 files.
13. Launcher stdin contract: target children are intentionally non-interactive;
    Neutralino's stdin pipe is closed immediately after spawn. This fixes the
    Windows `tsx watch` + `require("process")` pipe deadlock without modifying
    the target project or disabling its file watcher.
14. The generic proxy makes local HTTP origins display without target changes,
    including XFO/CSP framing denial, HTTP, WebSocket, cookies, and local
    redirects. A target that hard-codes absolute requests back to its upstream
    origin still bypasses any server-side proxy and should use root-relative or
    `location.host` URLs in development.
15. Basic HTML inspection is target-agnostic: the proxy injects a compatibility
    Bridge into ordinary HTML responses, so Connected/Freeze/HTML selection
    work without target source changes. Native integration is still needed for
    authoritative `file:line`, R3F/Konva hit metadata, or target-specific state
    coordination. Unsupported document encodings, oversized documents, or a
    blocked injection policy remain display-only and report `Bridge
    unavailable`; the original target is never modified.
16. `html2canvas` reproduces DOM/CSS rather than compositor pixels. Cross-origin
    images without CORS permission, complex filters, shadow DOM, video, and
    WebGL can be incomplete; 3D/Konva captures require target-provided bounds or
    callbacks and are never fabricated. Capture failure degrades to
    metadata-only rather than blocking the send.
17. One Send supports at most four active component crops. The contact sheet
    labels the same canonical citation numbers shown in the Chat cards.
18. Auto CSS preview is a runtime-only preview. It does not write to the target's
    source files and provides no apply-to-source or file diff; writing real
    source changes is intentionally out of scope for this phase and would need
    a separate diff/backup/undo flow.
19. Markdown/KaTeX and the inline Lexical editor increase the production
    JavaScript bundle beyond Vite's 500 kB warning threshold (main chunk ≈
    996 kB). Build output remains functional; route-level code splitting can
    reduce initial load without changing rendering.
20. The inspector's own project ships with a small number of `oxlint` warnings
    (legacy ANSI-control regexes, the minified Neutralino runtime, and React
    fast-refresh/export hints); there are 0 lint errors. The build, typecheck,
    and tests are clean.
21. The composer tag list is a controlled list: the props are the single source
    of truth, so a tag removed optimistically reappears if the authoritative
    list still contains it. This is deliberate (the target can refuse a
    deselect) and is surfaced as an inline notice rather than a silent
    disagreement, but it does mean a removal is only final once the Bridge
    confirms it.
22. Tags sit where the user put them, so the caret is free everywhere in the
    paragraph — including before a tag. A tag chosen while a text range is
    selected is appended at the end of the sentence rather than replacing the
    highlighted words, so a selection is never swallowed by picking a component.
23. `Ctrl+Z` restores a removed tag and asks the target to re-select it, but the
    re-selection is a round trip: if the target's record was dropped by a route
    change or a session reset, the tag comes back in the composer with no
    highlight to match it. The Bridge declines to activate a record whose element
    is gone rather than outline nothing.
24. An assistant message now carries the citations of the request it is
    answering, and a `({1})` in its prose renders as a chip that re-selects the
    component in the inspected page. Before this the row was only ever on a user
    bubble and the model's own markers had nothing behind them.
25. `scripts/target-proxy.mjs` used to read the Bridge sources once per process,
    so editing `bridge/vera-inspector-bridge.ts` had no effect until the proxy
    restarted. `createBridgeSourceLoader` now compares an mtime/size fingerprint
    on every read and drops the transpiled artifact cache when it moves. This was
    a developer-experience trap rather than a product defect: a stale proxy
    silently served an older Bridge.
