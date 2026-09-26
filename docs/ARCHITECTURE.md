# Architecture — Design Inspector Tool MVP

## 1. State ownership (§3)

| Owner | Owns | Files |
|---|---|---|
| Bridge (target runtime or proxy-injected compatibility runtime) | `inspectorFrozen`, inspector mode, live `SelectionRecord`s (incl. measured `styleFacts` §9e), live highlight/label DOM, `connectionId`, `documentGeneration`, `routeEpoch`, runtime CSS preview layers, selectionId→logical anchor registry | `bridge/vera-inspector-bridge.ts`, `scripts/target-proxy.mjs` |
| App A | session selection intent (`persistedActiveSelectionIds`), chat history, proposal decisions, settings, localStorage, export inputs, preview transactions (`apply`/`undo`/`reset` + decisions), style-fact sanitizing for the state boundary, cited-source fetch and cache | `src/hooks/*`, `src/state/*`, `src/persistence/*`, `src/preview/*`, `src/style/*`, `src/target/*` |
| Supervisor | the project root it is allowed to read from (`job.dir`), the active App origin its routes are gated to, and the cited-source route built on both (§9h) | `scripts/with-launcher.mjs`, `scripts/source-reader.mjs` |

Reconciliation rule: after every new handshake/snapshot, App A filters its
persisted IDs against the live snapshot (`src/state/reconcile.ts`). IDs absent
from the snapshot are dropped from the **active** set (reported as
`droppedStaleIds`) but historical chat citations are untouched.

## 2. Lifecycle

```
Canonical local target → dedicated loopback proxy origin → iframe →
HELLO retry loop → HELLO_ACK (new connectionId) →
SNAPSHOT (full live state) → heartbeat PING/PONG (4s/10s timeout) →
…freeze/select/chat/export/preview… → SPA route change (routeEpoch++, preview rebind) →
session switch (preview+selection reset) → reload/HMR → new connectionId+generation →
snapshot → reconcile → stale IDs dropped
```

- Handshake is retry-based (1.2s); one-shot timing is forbidden.
- HTML documents from the isolated route receive a compatibility Bridge before their head closes; CSP receives the exact inline script hash, so basic Freeze and HTML selection need no target edit.
- `Reconnect` = invalidate connection assumptions + fresh HELLO + snapshot.
- Each Bridge instance gets `connectionId`; each document gets
  `documentGeneration`. Late messages from older generations/sequences are
  rejected by `validateBridgeMessage` before any state mutation.
- SPA `pushState`/`replaceState`/`popstate` are observed by the Bridge. Every
  route change increments `routeEpoch`; App A re-resolves each applied preview
  transaction against strong anchors (unique `id` or `data-testid`) and drops
  layers that resolve to zero (`unbound`) or more than one element
  (`ambiguous`) rather than mutating an unrelated node.
- Switching to a different session on the same canonical target sends
  `VERA_INSPECTOR_SESSION_RESET` to the Bridge, clearing the live selection set,
  selection→anchor registry, and every runtime CSS layer. Selection, capture,
  and preview state never leak between sessions of the same target.

## 3. Protocol trust model (§7)

- Envelope on every message: `{ protocolVersion, type, connectionId,
  documentGeneration, requestId, sequence, payload }`.
- App A posts to the **exact proxy frame origin** derived from the loaded URL
  (never `"*"` when known); the canonical target origin remains session metadata.
  Bridge validates `event.origin === appOrigin`.
- Both sides validate `event.source` (`iframe.contentWindow` / `window.parent`).
- Payloads are schema-validated; stale connection/generation/sequence and
  selections without Bridge-issued `selectionId` are dropped silently.

## 4. Selection identity (§5)

- `selectionId`: Bridge-issued (`sel-…`), never App-A-issued.
- `elementKey`: stable logical identity — explicit `data-inspector-key`, then
  `data-testid`, `id`, then a deterministic DOM path (survives React remounts).
  R3F/Konva keys come from Vera-registered metadata.
- Toggle-off reuses the same `selectionId` (state → inactive); reselect in the
  same document generation reactivates the same record. IDs live for the whole
  document generation; a new generation starts fresh.
- Numbering: App A owns the active display order; the protocol carries
  `activeOrder` so Vera labels and the App A tray agree (single owner).
  Export order is separately `order` (first-added).
- At most 4 selections can be active at once (cap comes from Bridge
  capabilities, App A enforces `Math.min(4, maxSelectionImages)`), so one Send
  carries at most four crops.
- The Bridge keeps a `selectionId → { idSelector, testId, elementKey, label }`
  anchor per selection. This anchor (not a node reference) is what CSS preview
  re-resolves after route changes, so a preview follows a component across SPA
  navigation without App A holding stale DOM references.
- Removing a composer's tag is a deselect request (`VERA_INSPECTOR_CLEAR_SELECTION`),
  so the tray, the export set, the persisted intent, and the placeholder count
  all move together. `reconcileActiveSelections` only keeps ids that are both
  `state === 'active'` **and** present in the snapshot's `activeOrder`, so a
  cleared selection can never linger in the UI or in an export.

## 5. Freeze (§9)

- `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) in **both** contexts: App A narrow
  key handler (no inspection) + Bridge iframe handler (attached at init so it
  works while Live). `Alt+Shift+F` remains as legacy fallback. Rationale:
  Windows reserves `Alt+Shift` for language switching and Chrome swallows
  several `Alt+Shift` chords, so the legacy chord often never reaches the page.
  Explicit `{ active: boolean }` commands with a 400ms double-toggle guard.
- Freeze ON: a pointer shield arms inside the shadow host, the freeze stylesheet
  is injected, keyboard/editing blockers attach at window capture, the active
  element is blurred, hover/select become active. See §9g.
- Freeze OFF: canonical live reset — shield and stylesheet removed, blockers
  detached, hover cleared, live highlights + registry cleared, snapshot emitted;
  App A drops the active set, history preserved. The Freeze shortcut and
  `Escape` stay live throughout, so the user can always get back out.

## 5b. Target entry

App A intentionally exposes no manual URL field or folder picker. Targets enter
through the Launcher handoff (`?target=...&inspectorToken=...`), the deterministic
first-run default, or a target already stored in the session. The Supervisor
remains the only component allowed to allocate a generic loopback proxy route.
`npm run dev:web` can reopen a stored target but cannot provide proxy control.

## 5c. Launcher + supervisor (desktop window, launcher-owned child)

Generic target transport — no dependency on the target's name or framework.

```
npm run dev (= scripts/with-launcher.mjs)
 ├─ vite (App A) — 127.0.0.1, port sniffed from stdout
 ├─ Launcher (Neutralino, 480×660)
 │    folder pick → spawn OWN child (npm run <script>) → port detect
 │    → close stdin → minimize → close kills the tree and releases proxy
 ├─ target proxy (OS-assigned port on an isolated 127/8 address per target)
 │    HTTP + WebSocket streaming, redirect/cookie/framing-header rewriting
 ├─ browser handoff: ?target=<canonical>&inspectorToken=<one-time>; App A requests route
  └─ 127.0.0.1:5199 status + App-origin-gated proxy control + cited-source API
```

- **Ownership:** the Launcher spawns the target via `os.spawnProcess`, closes
  its stdin pipe immediately with `os.updateSpawnedProcess(..., 'stdInEnd')`,
  and kills the process tree on window close (`taskkill /PID /T /F`). Closing
  stdin is required on Windows because Neutralino opens a pipe for every spawned
  process; keeping it open can deadlock `tsx watch` before `app.listen()`.
- **Job file** (`%APPDATA%/design-inspector/target.json`): the Supervisor creates
  its parent directory; the Launcher serializes writes to
  `{dir, script, requestedAt, last:{dir,port}, history[≤5], status}`. The
  Supervisor is read-only. A terminal `stopped` write completes before
  `app.exit`, and Supervisor-side port/liveness reconciliation is a backstop.
  Supervisor kill-backstops verify that the recorded PID was created after the
  job request, preventing stale PID reuse from terminating an unrelated process.
  Retry first kills any still-running owned child, preventing orphan overlap.
- **Port resolution:** Launcher snapshots before spawn, waits for a new
  responder, and also parses explicit `Local:`/`pinned to <port>` log
  announcements for off-list ports. The Supervisor independently probes the
  canonical IPv4 origin before allocating a route, so stale `running` jobs do
  not produce false browser opens.
- **Canonical vs frame URL:** `target` is the real HTTP loopback origin persisted
  in the session. Supervisor pairs it with a random one-time `inspectorToken` in
  the browser URL; App A presents that token only while acquiring the current
  route, then strips it from history. The returned ephemeral `127/8` origin is
  used only by the iframe and Bridge origin checks. Supplying an arbitrary
  target/frame URL in the query is not trusted. The proxy strips
  `X-Frame-Options`, replaces every enforced/report-only CSP `frame-ancestors`
  with the exact App A origin, rewrites local redirects and cookie domains, and
  injects the compatibility Bridge into top-level HTML. Non-document HTTP and
  WebSocket responses remain streaming; HTML injection is bounded and falls open
  to the original document if its size or encoding is unsupported.
- **Control boundary:** each route binds an OS-assigned port on a distinct
  `127/8` address, isolating host-only cookies from App A and other routes.
  Upstream URLs are restricted to HTTP loopback origins with an explicit port and
  no path, credentials, query, or fragment. Status reads and route mutations
  require the exact active App origin; proxied browser traffic must have an
  allowed Origin/Referer/Fetch-Metadata combination. Automatic query handoff
  additionally requires the unconsumed 256-bit route token. Monotonic request
  IDs stop late route responses from replacing a newer selection.
  Inspector-owned ports are rejected to prevent loops.
- **Coupled shutdown:** Launcher close kills the target tree, waits for the
  stopped job write, and closes the active route. Supervisor exit also releases
  proxy sockets and backstop-kills the recorded target pid.
- **Logs:** spawned-process events stream into the Launcher and job
  `status.logTail`; Supervisor status exposes canonical target and proxy URLs to
  App A's diagnostics drawer.
- **Bridge boundary:** the proxy makes arbitrary local apps display and inspect
  HTML without target framing or source changes. It transpiles the Bridge and
  compatibility capture adapter, prepends the bounded `html2canvas` browser
  distribution, injects the combined script into the target document, and adds
  only its CSP hash on the isolated route. A native target Bridge takes
  precedence when present. Target-side integration is still required for
  authoritative `file:line` metadata, R3F/Konva hit-testing, or target-specific
  state coordination — the proxy invents no location. Once a target does report
  one, the Supervisor serves the text around it (§9h); the proxy never does.
  Iframe reloads and Bridge HMR restart HELLO retries, and a
  validated new Bridge connection resets sequence tracking. Hard-coded absolute
  URLs back to the upstream origin also bypass any server-side proxy and remain
  a target concern.
- **Degradation:** if the Launcher binary is missing, `npm run dev` still starts
  App A and the Supervisor for stored targets. If compatibility Bridge injection
  is blocked by an unsupported document policy, the target still renders and the
  UI reports `Bridge unavailable` instead of presenting a fake Freeze state.
  `npm run dev:web` has no Supervisor and therefore no generic target transport.

## 6. Ollama (§16)

Direct browser `fetch` to the configured base URL (default
`http://localhost:11434`; CORS via `OLLAMA_ORIGINS`). Precedence: global model
is the default for **new** sessions only; each session stores its own model.
`/api/tags` for discovery; connection test performs a real non-streaming
`/api/chat`. Streaming via incremental NDJSON parser tolerant to chunk/UTF-8
splits. Bounded context (last 40 completed messages, 32k response cap).
Duplicate-send blocked while streaming; Stop aborts without marking success;
Retry preserves the user request and opens a new assistant attempt; per-token
session-identity guards reject late tokens after session switch. Every request
starts with a fixed English system role that instructs Ollama to produce a
Korean, designer-ready UI/UX handoff with evidence and implementation guidance.
Screenshot text remains evidence rather than executable instruction.

When visual citations are active, App A first requires a loopback Ollama endpoint
and rejects `:cloud` models. It verifies `/api/show` capabilities and sends one
`/api/chat` user message containing a numbered contact sheet followed by the
individual component crops. The prompt maps every image index to its canonical
citation number and treats image text as untrusted visual data. Explicitly
non-vision models are blocked before the user message is created; raw image bytes
are never written to localStorage or diagnostics.

Visual capture is best-effort and never blocks a send: a failed or partial
capture degrades that citation to metadata-only (component/file/line text, no
image) instead of rejecting the request. If the contact sheet cannot be built
from individual crops, the surviving crops are still sent individually. This
keeps "select and ask" working on pages where rasterization is partial.

### The images have a job, not just a prohibition

The system prompt used to say only that image text is untrusted and that the
numbers win. That is a floor, and a floor is not a brief: a model told what an
image may not be used for still produces a paragraph about the component it
cannot see any judgement in. The prompt now gives the images work — the outline,
the balance, how the component sits in its surroundings, what draws the eye — and
asks for it in a person's terms: look at them the way a person looks at a screen.

The line it has to hold is the scale. **A screenshot has no scale, so a
measurement is never read off one.** Comparing two facts is reasoning and is
allowed — is this padding larger than that one, is the alignment consistent, does
the hierarchy read. Turning pixels into a number is not reasoning, it is
fabrication, and it is named as such.

The same split governs new values. Describing the **current** state is bound by
the facts: if a value is not there, it was not measured, and the answer is
확인 불가 with the property named. **Suggesting** a change may introduce values
that do not exist yet, because they are the whole point of a suggestion — they just
have to be marked as proposals rather than presented as measurements.

And the derived tokens are verdicts, not topics. A `contrast`, `text-truncated`
or `font-load` token is a result the browser already reached: quote it, never
recompute the ratio, and never replace `unmeasurable` with a number of your own.

## 6b. Structured CSS preview (auto, runtime only)

- The English system role asks the model to append exactly one fenced block
  tagged `design-inspector-preview` containing a JSON array of
  `{ selectorId, declarations }`. The visible answer remains Korean; the block
  is stripped before rendering.
- Streaming sidecar parsing buffers split tokens, tolerates truncation, and
  only yields a payload for a strictly valid, schema-conformant, allow-listed
  JSON array (`src/preview/sidecar.ts`, `src/preview/cssPolicy.ts`). Invalid,
  oversized, truncated, or errored responses simply produce no preview.

### A fence info string within 2 edits still counts as an attempt

A 9B model that had the exact tag in its context wrote
`design-insector-preview` — one letter out. The consequence of a near miss is not
a lost preview: nothing recognises the fence, so the JSON payload is printed
into the answer as visible text. A fence whose info string is within two Levenshtein
edits of `design-inspector-preview` is therefore treated as an attempt at ours and
stripped. Two is the bound: near enough to be a slip of the same token, far enough
that `design-inspector-preview-note` (five edits) stays ordinary prose, which a
test pins.

Everything downstream of fence recognition is untouched. A near-miss block goes
through the identical truncation, oversize and schema-validity path as an exact
one, so a typo cannot smuggle anything past the validator — the tolerance only
decides that a block is *ours*, never that it is *acceptable*. A `blocksNearMiss`
stat makes the slip visible instead of silent.

What it deliberately does **not** fix: a partially streamed near-miss tag can
flash for a frame or two before the newline completes the line, because the
streaming guard only hides prefixes of the correct tag. Hiding every unrecognised
fence would mean hiding the user's own code blocks, and the payload leaking is the
part that has to be prevented.
- `usePreviewController` turns one clean assistant completion into a single
  atomic transaction. It resolves `selectorId` to a strong anchor, applies a
  bridge-owned `<style>` layer through `VERA_INSPECTOR_PREVIEW_APPLY`, and only
  reports success when the bridge confirms the layer. Each transaction persists
  an `apply`/`undo`/`reset` state plus its decision.
- Previews are runtime DOM mutations only. The inspected project's source files
  are never written, and there is no file-diff or apply-to-source path. Undo and
  Reset re-resolve the anchor and remove the layer; reload/route changes re-apply
  through rebinding (§2). Auto preview is off by default and can be enabled in
  Settings.

## 7. Export (§19)

Pure function `buildAgentPrompt({ session, active })`: latest raw user request +
deduped reconciled active (first-added order) + a fixed template, `\n` endings,
exactly one trailing newline. No AI call.
`buildRawTranscript` is the separate untransformed export.

Pin-based constraints are gone. The accepted change log is the durable record of
what was decided, and it is exported through the change-log panel and the
proposal document instead (§9f).

## 8. Persistence (§15)

`localStorage` key `design-inspector/v1`, `{ version, data }` envelope, schema
v2 (v1 shapes migrate in place: legacy sessions gain empty preview
transactions/decisions), corruption → deterministic empty recovery,
quota/write-failure surfaced (never thrown), in-flight `streaming` messages
migrated to `interrupted`. Multi-tab policy: last-write-wins; live state always
re-reconciled against the Bridge snapshot. Split ratio uses the independent
`design-inspector/layout-v1` key so resizing never rewrites session data.
Visual crop bytes stay in memory for the active app session and are never placed
in the localStorage envelope; only preview transaction state and design
decisions are persisted. The cited-source window cache is the same: a
module-level LRU in `src/target/sourceCache.ts` that dies with the page, never
the envelope.

## 9. Visual system (§0.1)

Light-first calm AI workspace: off-white app bg, white surfaces, gray
separators, near-black text, single sky accent, section-§20 composition
(minimal header → dominant Vera frame → priority chat → drawers for
sessions/settings/diagnostics). The desktop split defaults to 40% chat and is
adjustable from 25–60% with pointer or keyboard controls. Dragging the divider
toward the right grows the **target** and shrinks chat; toward the left it grows
**chat** and shrinks the target (the divider is a physical handle between two
pane edges). Markdown answers use GFM, hard line breaks, fenced code, and KaTeX
inside a bounded assistant bubble. No dashboard chrome, no neon, monospace only
for code/paths/ids.

## 9b. Composer document model

The composer is a Lexical editor, but the **tag list is a controlled list**:
`Composer`'s props (derived from the reconciled active selections) are the
single source of truth, and the editor document is reconciled to them on every
commit rather than only when a prop identity changes. This is what keeps the
document and the selection from drifting apart when a tag is removed
optimistically.

- **Single block invariant.** `$normalizeComposerBlocks` merges any extra block
  into the first paragraph (keeping `\n` as `LineBreakNode`s), so the tags and
  the caret can never end up on separate lines.
- **Tags live in the flow, not in a pinned run.** Tags are inline atomic
  `DecoratorNode`s that sit wherever the user put them, so a sentence can
  interleave them: `make ({1}) and ({2}) more compact`. `$reconcileTagNodes`
  matches by id rather than by position, which is what lets a new selection land
  at the caret without re-mounting the tags already on screen (re-mounting would
  kill both the caret and the entry animation). There is no pinned region and no
  caret clamp: every position in the paragraph, including before a tag, is legal.
- **Insertion at the caret.** `$insertAtCaret` places a tag exactly at a
  collapsed caret, splitting the text node when the caret is mid-word. It is
  written by hand rather than through `RangeSelection.insertNodes`, which removes
  whatever its own range resolves to — for a collapsed caret that is the whole
  text node the caret sits in, so a tag chosen mid-sentence took the sentence
  with it.
- **Caret adjacency.** `$adjacentAttachment` reports a tag on either side of a
  collapsed caret, and only when nothing but the tag separates them from the
  next character, so `Backspace` in the middle of a word still deletes a
  character. The backspace arm is keyed on that adjacency identity rather than
  the raw selection signature, because Lexical normalises an element point into
  a text point on the next commit.
- **A hold deletes text.** `decideBackspace` checks for an adjacent tag *before*
  it looks at `event.repeat`, and a repeat resolves to `passthrough` rather than
  `ignored`. Returning `ignored` still called `preventDefault`, so a held
  Backspace deleted nothing anywhere in the composer. Holding next to a tag now
  abandons the arm instead of confirming the removal.
- **A drag is deliberate.** `×` and a completed double-`Backspace` keep the
  two-phase removal so a stray keystroke cannot destroy a citation. A non-
  collapsed range that covers a tag does not: `$tagsInSelection` finds what the
  gesture swallowed and it goes in the same commit.
- **Removal is two-phase.** `×` or a completed double-`Backspace` marks the node
  removing (it plays its exit transition), asks the parent to deselect, then
  finalises the node after the transition. While a node is removing it is
  excluded from reconciliation so it cannot be restored mid-animation. The
  removal opens its own history entry (`HISTORY_PUSH_TAG`) and its follow-up
  commits merge into it, because `HistoryPlugin` otherwise folds a removal made
  within a second of typing into the typing entry, leaving Ctrl+Z nothing to
  bring back.
- **The document reports gestures the composer did not author.** The update
  listener diffs the tag set on commits that carry none of the composer's own
  update tags. A tag that vanished without a two-phase removal was a gesture — a
  drag, a cut — so the target is told to deselect. A tag that reappeared is an
  undo, so the target is asked to re-select it through
  `VERA_INSPECTOR_RESELECT_SELECTION`, and the reconcile holds the id until that
  round trip lands. Only an id the composer announced as removed counts as a
  restore, so an undo cannot resurrect a tag the props legitimately dropped.
- **Tag removal deselects.** `clearSelectionConfirmed` posts
  `VERA_INSPECTOR_CLEAR_SELECTION`, then resolves against the next Bridge
  snapshot: `true` when the selection is gone, `false` on timeout or when the
  target kept it. On `false` the controlled list restores the tag and the
  composer shows an inline notice. The selection count shown in the placeholder
  is always derived from the tags themselves, never from a second counter.
- **Motion.** Tag enter/exit, the armed double-backspace pulse, capture
  shimmer, image fade-in, error shake, and a tag→chat hand-off on send are all
  CSS-driven (`src/editor/motion.ts` holds the timings, `AttachmentFlyLayer` the
  decorative hand-off). `prefers-reduced-motion: reduce` collapses the
  transitions and skips the hand-off entirely; a reduced-motion removal
  finalises the node immediately.
- The send button clears the draft and the tags only after a successful request;
  a failure keeps both. The visual placeholder is suppressed while tags are
  present so it cannot peek out from under them, and the composer paragraph
  resets the UA `p { margin: 1em 0 }` so the placeholder and the first line share
  a baseline.

## 9c. The citation marker

`src/citationMarker.ts` owns the one notation used everywhere a component is
referenced: the composer's sent text, the `Inspected UI citations:` block, the
per-image mapping lines, the system prompt, and the rendering of a sent message.

- **`({1})`.** Chosen over `[1]`, which users type themselves, and over `{{1}}`,
  which belongs to Vue, Angular, Liquid and Handlebars. `({1})` is owned by no
  language or template syntax and still reads as prose, which matters because
  the model's own answer is written in sentences.
- **The braces are part of the token.** The pattern is the whole
  `/\(\{([1-9]\d?)\}\)/`, never a bare `\(\d+\)`: Korean technical writing is full
  of `우선순위 (1) 여백, (2) 대비`, and a looser pattern would turn an enumerated
  list into citations.
- **A reference is only a reference against a known citation.** When a sent
  message is rendered, `parseCitationMarkers` splits it and `UserText` renders a
  chip only for numbers that message actually carries. A marker the user typed by
  hand is left as text rather than silently swallowed, so the transcript can
  never disagree with what was sent.
- **User bubbles have no tag row.** The sentence is the record of what was asked
  about, and a reference sitting in the middle of a clause says more than a list
  under the bubble. Assistant messages keep the citation row, which is where a
  model-narrated reference belongs. No image bytes are stored with either.
- **An answer carries the citations of the request it is answering.** On a clean
  completion `useChat` patches them onto the assistant message, so the `({1})`
  markers the model was told to write resolve to real components. Without that the
  markers were prose with nothing behind them.
- **A marker in an answer is a control.** `MarkdownMessage` rewrites markers in
  the rendered prose into the same chip the composer uses, as a button: clicking
  it posts `VERA_INSPECTOR_RESELECT_SELECTION`, which re-activates the record and
  scrolls the element into view before outlining it. Only the immediate string
  children of a block are rewritten, so a marker inside a fenced block, an inline
  code span, a link or a KaTeX run is left byte for byte, and a marker the answer
  has no citation for stays the text the model wrote.
- The preview sidecar is unaffected: `"target"` stays a bare integer validated
  against `knownCitationNumbers`, so the marker is a text convention only.

## 9d. Development traps

- **The proxy reloads the Bridge on change.** `createBridgeSourceLoader` compares
  an mtime/size fingerprint of the three Bridge sources on every read and drops
  the transpiled artifact cache when it moves. Before this the sources were read
  once per process, so editing `vera-inspector-bridge.ts` did nothing until the
  proxy was restarted: a new command simply did not exist, and a message that
  arrived was ignored with nothing in the log to say why. A failed read keeps
  serving the previous sources rather than taking a working target offline.

## 9e. Style facts (measured DOM evidence)

A selection carries the values the target's own CSS produced, so the model can
answer "what colour is this?" with a hex code instead of "cannot tell" — and, in
`derived`, the handful of values it could not have computed for itself.

### Shape and ownership

`SelectionRecord.styleFacts?` is an **optional** field, added the same way
`anchor?` is. No new wire type, no new message, no new capability flag. The flow
is Bridge → snapshot → app state → `CitationSnapshot` → prompt / details panel.

The Bridge is authoritative and extracts live from the DOM in `recordPayload()`:
one `getComputedStyle` for the longhands and one `getBoundingClientRect` per
record, on every emit, plus the further `getComputedStyle` calls the derived
backdrop walk makes up the ancestor chain. There is deliberately **no
per-record cache** — a route change nulls `rec.target`, so the facts invalidate
themselves, and `emitSnapshot` only fires on discrete events (freeze, mode, route,
selection, request), never on hover/scroll/resize, so the live read is cheap.

### Derived measurements are computed, not asked for

`styleFacts.derived?` is an optional top-level key holding values that were
**measured rather than read**: a contrast verdict, an overflow flag, a font-load
state. The key is registered in **four** places that have to stay in sync — the
two TypeScript interfaces (`bridge/vera-inspector-bridge.ts` and
`src/protocol/types.ts`), `STYLE_FACT_KEYS` in `src/protocol/validate.ts`, and
`STYLE_FACT_ALLOWED_KEYS` in `src/style/properties.ts` — and gated twice, by
`isStyleFactsDerivedValid` on the wire and by `sanitizeDerived` at the state
boundary.

The reason is a measurement that moved. The same two colours came back as 4.80:1
in one run and 3.2:1 in the next, and a number that changes between two runs of
the same page is not a measurement. So the arithmetic happens once, in the
Bridge, where there is only one way to get it right — and where a value that
cannot be measured is reported as unmeasurable instead of estimated.

`contrast` is a verdict, not a ratio to be recomputed: `{ ratio, min, pass,
large, background }`, WCAG 2.x. `min` is 4.5, or 3 when the text is large —
`font-size >= 24px`, or `>= 18.66px` with `font-weight >= 700`. The ratio is
rounded to two decimals and `pass` is decided from the **rounded** ratio, so the
printed number and the verdict can never disagree. `background` is the resolved
backdrop the ratio was measured against, as `#rrggbb`, which is what makes the
verdict checkable rather than asserted.

**Three outcomes, not two.** A verdict; `{ unmeasurable: true }` when the styles
*were* read and the backdrop genuinely is not a flat colour — any
`background-image` other than `none` on the element or anywhere up its ancestor
chain, or `opacity < 1`; and the key **absent** when the inputs could not be
read at all, such as an element with no parseable text colour. A measurement
failure is not an answer, and calling it one would fill every prompt with a
caveat about something nobody asked about.

The backdrop walk starts at the element, climbs `parentElement` past fully
transparent backgrounds, and resolves to white at the document root — the
browser's own canvas default rather than a guess about the design. A partially
transparent text colour is composited source-over in sRGB first, which is what
the compositor does. Two things are deliberately **not** accounted for:
`box-shadow` and an overlapping sibling, because neither appears in the style
the walk reads.

`truncated` is present only as `true`, and only when `clientWidth > 0` and the
content overflows its box by more than 1px on either axis. `false` is the
unremarkable state and is omitted, exactly like a default-valued property: the
field's absence is the "it fits" answer.

`fontLoad` is only ever `'fallback'` or `'unknown'`. `'fallback'` when the
document **declares** the first computed family through `document.fonts` and
`check()` says it did not load. A family the document never declares is a local
or system font: there is no load event that could have failed, so it produces no
key at all.

In the prompt this is one tail segment after the font longhands —
`contrast 4.54:1 min 4.5 pass`, `contrast unmeasurable`, `text-truncated`,
`font-load fallback` — and in the details popup a `Measured` group carrying a
swatch of the backdrop the ratio was measured against. An unmeasurable contrast
says so there rather than showing nothing, because a blank row reads as "no
problem found".

`contrast` is not a CSS property, which is exactly why the system prompt tells
the model to quote the token and never recompute a ratio. Under the 1,200-char
storage budget `derived` and `geometry` are the **last** things dropped, after
every style group: the group drop order never reaches them.

### Relations between cited elements

`src/style/relations.ts` answers the one question a designer actually asks across
two elements — do these two overlap? — by intersecting the bounding boxes the
Bridge already put on each citation. That is pairwise arithmetic in the app: no
new bridge message, no new protocol surface, no second round trip, and a zero-area
box is skipped rather than allowed to divide by zero.

In the prompt it appears as a `Measured relations (from the boxes above):`
section, and only when two or more citations actually intersect. Each line names
the intersection rectangle, the share of the smaller box it covers as a whole
percent, and then states the limit in the same sentence: paint order was not
measured, so which element is in front is unknown.

That last clause is load-bearing. `z-index` and `position` are allow-listed CSS
**values**, not stacking data, and the Bridge omits both whenever they equal their
computed default; no ancestor carries geometry; and paint order is not in the
payload at all. Answering "the badge covers the text" from a rect intersection
would be a guess wearing a measurement's clothes. The overlap is reported, and
the stacking question is left explicitly open.

### The Bridge cannot import from `src/`

`scripts/target-proxy.mjs` transpiles each Bridge source with
`ts.transpileModule` and concatenates them. There is no module resolution, so
the allowlist, the defaults table, the sanitizer, the colour conversion, and the
derived-measurement arithmetic all live inline in
`bridge/vera-inspector-bridge.ts`. `src/style/properties.ts` keeps a second,
stricter copy for the app side. **The duplication is the trust boundary**: the
target controls the payload, so the app drops any property it does not recognise
rather than trusting the Bridge's list.

### Defaults are per property, not one global list

Omitting defaults is what leaves only the surprising values, but "is this the
default" is a per-property question: `0px` is unremarkable on `margin-top` and a
finding on `padding-top`, and `display: block` is noise on nearly every selected
element while `inline-flex` is the whole point. `STYLE_FACT_DEFAULTS` and
`STYLE_FACT_ZERO_DEFAULT_PROPS` encode that; a single flat list cannot.

56 longhand properties in five groups (color 10, typography 11, box 19, layout
12, motion 4). `props` is longhands only — a shorthand would hide a single
differing side. `derived` is a separate key, because a contrast ratio is not
something CSS has a name for.

Two rules in here were **wrong until a real page was measured** (see
`VERIFICATION_REPORT.md`, "Live real-capture verification"):

- `background-color` is **not** treated as a default. Filtering
  `rgba(0,0,0,0)` looked right in the fixtures, but in practice it made the
  model answer "버튼 2 배경색 확인 불가" about a ghost button whose background
  was plainly knowable. The filter manufactured a gap in the evidence it was
  meant to keep tight. `transparent` is a fact about a component.
- `border-*-color`, `outline-color` and `caret-color` have initial value
  `currentColor`, so `getComputedStyle` resolves them to the element's own text
  colour. When the computed value equals `color` it is an echo, not an authored
  choice, and is dropped. This cannot distinguish an author who deliberately
  matched the border to the text from one who inherited it; the width and style
  survive, and the colour is recoverable from `color`.

`fill` and `stroke` initial to `black`, not `none` — getting that wrong put
`fill: rgb(0,0,0)` on every HTML element.

### The facts block uses real property names, not a shorthand

The head and tail segments are written with the names the CSS itself uses —
`padding:12px 16px`, `border-radius:8px`, `color:#1f2937`, `font-weight:600` —
so a fact and a declaration key are one vocabulary and nothing has to be decoded.

The compact shorthand this replaced (`box=`, `radius=`, `font=`) cost twice,
and the second failure is the one that decided it. A 9B model read
`box=12px 16px` as a declaration key and emitted `{"box":"12px 16px"}` in a
preview block, which `validatePreviewBlock` rejected as `unknown-property` —
discarding the valid declarations beside it — and the system prompt grew a
mapping rule to cover for that. With the mapping in place, a real run then showed
the model quoting the shorthand straight back into its **visible** answer:
`box=12px 16px`, `radius=8px`, which the person reading it cannot parse. That is
the copy-paste-text complaint the prompt rewrite was meant to end, so the tokens
went rather than the explanation. What the prompt keeps is the negative rule:
never invent a token from a facts label, and never echo one into prose. The
machine channel is still guarded twice — by the prompt and by the sidecar.

### Colours are normalized to sRGB before they leave the target

`getComputedStyle` preserves the authored colour space: `oklch(…)` and
`color(srgb …)` come back as written, and a 9B model cannot read them. Verified
against both jsdom and current Chrome — neither converts to `rgb()`.

`normalizeStyleColor` therefore paints the value into a 1×1 canvas and reads the
pixel back, which always yields sRGB bytes. `rgb()`, `rgba()`, hex and
`transparent` take a regex fast path and never touch the canvas. A value that
cannot be converted is **dropped, not passed through**: raw passthrough is the
prompt-injection path. The readback is guarded against the black sentinel, so an
unparseable value cannot masquerade as `#000000`.

### Untrusted by construction

Every string in `styleFacts` is controlled by the target page and reaches the
model prompt. Three independent gates:

1. **Bridge** — values capped at 120 chars, label at 80, ancestors at 3 levels
   (stopping at `body`), control characters in `[\u0000-\u001f\u007f\u0080-\u009f]`
   replaced with a space, whitespace collapsed.
2. **Wire** — `isStyleFactsValid` in `src/protocol/validate.ts` is a **subset**
   allowlist, not `hasExactKeys`: the Bridge omits every default, so the key set
   is a partial set by design. Unknown keys, wrong types, over-long values, a
   manipulated `geometry`, and a malformed ancestor chain are all rejected.
   `derived` is validated by the same route: an unknown sub-key, an empty block, a
   `truncated: false`, a `fontLoad` outside the two-word set, a `ratio` outside
   1–21, a `background` that is not `#rrggbb`, or a `unmeasurable` marker with
   anything riding along beside it all fail the message.
3. **State** — `sanitizeStyleFacts` runs again in `citationFromRecord`, because
   `CitationSnapshot` is persisted on both user and assistant messages and would
   otherwise multiply across a session. A 1,200-char per-record budget drops
   whole groups (motion first, colour last) rather than truncating values: a
   missing `filter` is honest, a half-written one is not. `geometry` and `derived`
   survive every one of those drops. `sanitizeDerived` keeps the same bargain for
   the block: a contrast that does not survive is dropped whole rather than half
   a verdict being kept.

In the prompt the block is fenced as ```` ```untrusted-evidence ````, the system
prompt names style values and element text as untrusted evidence explicitly, and
the block precedes the images — the measurements are authoritative, the image is
reference.

### The facts never enter the agent export

`src/export/serialize.ts` is AI-free and its output is pasted into another tool
by a human, with no untrusted-evidence framing. Style facts stay in the model
transmission only; `serialize.test.ts` pins that. The cited **source text** read
for the proposal document and the details popup never goes the other way either:
the export carries the `path:line` string the target reported, never the lines
around it.

### Image policy and the `:cloud` gate

Images are attempted for every send. `prepareVisualContext` returns a
**discriminated union** with a named reason, not `undefined` — the composer
blocks on this call, and a silent `undefined` is what left the Send button
reading "Preparing…" with nothing to show for it. The reason reaches both the
composer (as a note, not an error — the send succeeded, it just carried no
pixels) and the prompt.

The endpoint must be loopback. A `:cloud` model is served by Ollama's cloud
**even from a loopback endpoint**, so the old `:cloud` guard was the only thing
between a screenshot and leaving the machine; it is now removed deliberately, the
prompt states that the images left the machine, and the composer says so. This is
the one place where a local-only app transmits data off-box, and it is a
disclosure rather than a block — revisit it if a remote endpoint is ever
configured.

`font-family` is worth calling out for a different reason than the other values:
it answers the first question any design review asks ("what font is this?"), and
installed font names are a weak signal — an OS font list, not user data. The
honest framing of §9e's exposure is the mechanism, not this one property: **every
send transmits target-derived text regardless of whether the model can see
images**, because the facts block is unconditional. Against a loopback Ollama
that is not a concern. Before configuring any remote endpoint, that property
becomes the one to reconsider, along with the `:cloud` disclosure above.

### The focus hint is a deterministic heuristic, not a router

When the request text matches the keyword table in `FOCUS_HINTS`, the prompt
carries one line naming the attribute groups the question is about. It matches on
colour, typography, box, layout and motion vocabulary in Korean and English.

What it is not:

- **Not a classifier.** An abstract or mixed request ("이거 괜찮아?") matches
  nothing and no hint is emitted. That is the intended behaviour — a wrong hint
  would pull the model toward attributes the user did not ask about.
- **Not model-based routing.** The original plan called for a hybrid that has the
  model classify the request first and route on that. It is deliberately **not
  implemented**: a second inference per send doubles latency on a local model and
  adds a new failure mode (what does the send do when the routing call fails?).
  A 20-line deterministic map with tests is the honest trade at this model size.
  Revisit if a cheaper signal becomes available, or if the model is fast enough
  that a second call is invisible.

The measured effect of the wider prompt rewrite is in `VERIFICATION_REPORT.md`
("Live 9B A/B verification"): it removed invented values and cut the answer by
3.5×, but did **not** achieve the intended 1–2 sections for a narrow question.
That instruction needs its own work.

### Testing note

jsdom's `getComputedStyle` returns `''` for most longhands — `font-size`,
`line-height`, `position`, `border-radius`, `transform`, `filter`, `z-index`,
`gap`, `opacity`, `letter-spacing`, `outline-color` among them. A style-facts
test without an explicit per-property fixture passes while measuring nothing.
Every such test stubs it, and the canvas stub deliberately ignores unparseable
values the way a real `CanvasRenderingContext2D` does.

The derived keys inherit the trap and add to it, because they read values no
longhand fixture happens to cover: `color`, `font-size` and `font-weight` decide
the contrast verdict, `background-image`, `background-color` and `opacity` decide
the backdrop walk, `clientWidth`/`scrollWidth` decide the overflow check, and
`document.fonts` decides the font-load one. A test that stubbed the longhands has
stubbed none of these, and the honest result of a derived assertion against an
unstubbed environment is an absent key rather than a wrong one.

## 9f. Proposals, decisions and the change log

The product is a preview-first editor. A model answer that carries a preview
block is a **proposal**, and it is provisional until the user decides:

| state        | meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `pending`    | applied to the target, undecided                                 |
| `accepted`   | the user pressed Accept; the change stays applied                 |
| `rejected`   | the user pressed Reject, **or** sent the next message undecided   |

Sending the next message settles every pending proposal as rejected. That is the
deliberate policy, not an oversight: accept/reject is opt-in, and moving on is
itself a decision. A rollback only touches the page when it is a reject; accept
is a no-op on the target because the change is already applied.

`src/preview/proposal.ts` derives all of this from the session and formats the
lines. It is pure — it never touches the bridge or mutates a session.

### What a decision carries into the next turn

The change log, never the answer text. Two earlier attempts were both wrong:

- injecting the head of the answer fed the model a wall of measured CSS once
  answers began quoting the evidence block;
- injecting the `## 디자이너 전달문` section depended on an output format the
  product no longer produces, and fell back to that same CSS dump.

The preview transaction is the only durable source: it already holds what
changed, on which component, and cannot drift from what was applied.

```
- [accept] PrimaryButton: padding 12px 16px, border-radius 10px
- [reject] SecondaryButton: background-color #f5f5f5 — reverted
```

Rejected proposals stay in the list on purpose — that is what stops the model
re-proposing a direction the user already turned down.

### Settling before the prompt is built

`settlePending()` writes the settled messages and transactions in one commit and
**returns them**. The caller builds the next prompt from the return value. A
session read after the commit is still the pre-commit value, so reading it would
silently drop the decisions from the request that just made them.

Rollback order is newest-first, because later transactions layer on top of
earlier ones.

A known limit: if a pending proposal was the basis of a later accepted one,
rolling it back leaves that later change computed against a state that no longer
exists. This is structural, not a bug to fix; it is documented rather than
hidden.

### The proposal document is deterministic

`buildProposalDocument(session, snippets?)` renders the accepted change log into a
handover document, and it is **not** written by the model. The document is meant
to be executed by a person or an agent, so every value in it must be one that was
measured and applied. A model-authored version could round a value, reorder a
property, or describe a rejected change. Rejected directions are listed
separately, and an unmeasured "before" is printed as `(측정 없음)` rather than
filled with a plausible default.

The optional second argument carries the cited source windows (§9h), read through
the supervisor. The snippet is quoted verbatim and bounded, never summarized, and
it is what separates "set the padding to 16px" from "set the padding to 16px, in
the branch that renders the primary variant": the numbers above it are measured
and applied, and these lines are where someone goes to do it.

The change-log panel and the document render from the same `buildChangeLog()`
output, so they cannot disagree.

## 9g. Freeze is an inert state

Freeze used to be a click block. `:hover` styling, hover handlers, Tab, typing,
focus rings, animations and transitions all kept running, which made it read as
"the page still works, minus a bit". It is now a real inert state:

- **Pointer shield.** A `position: fixed; inset: 0` div inside the shadow host,
  `pointer-events: auto` while frozen. The host is itself `pointer-events: none`
  and only this child opts back in. The page stops receiving pointer events at
  all, so `:hover` CSS, hover handlers, clicks, drags and context menus all stop.
- **Hit testing by coordinate.** With the shield up, `e.target` retargets to the
  host, so every hit would look like "the overlay". `onMouseMove` and `onClick`
  resolve the real element with `document.elementsFromPoint`, dropping the
  shield's `pointer-events` for the duration of the call. The event target is
  kept as a fallback for environments without geometric hit-testing (jsdom).
  Mouse-move hit tests are deferred into the existing rAF so the toggle costs at
  most one forced reflow per frame.
- **Keyboard and editing.** Window-capture blockers for `keydown`/`keyup`/
  `keypress` (the Freeze shortcut and Escape excepted, so the user can get out)
  and for `beforeinput`/`input`/`change`/`focusin`/`focusout`/`paste`/`cut`/
  `drop`/`dragstart`. The active element is blurred when freeze arms.
- **CSS stillness.** A document-level `style[data-vera-inspector="freeze-style"]`
  pauses animations, drops transitions, hides the caret and disables smooth
  scrolling. It lives outside the shadow root on purpose: the overlay must not be
  affected by the page, and the page must be affected by this.
- **Scrolling stays allowed.** It changes no app state and is the only way to
  reach an off-screen component.

What freeze does **not** stop: `setTimeout`/`setInterval`, `requestAnimationFrame`
loops, sockets and video playback. Stopping those means patching globals, which
can outlive the freeze and break the target page. True virtual time is a
CDP-only capability. This limit is stated in the Bridge header rather than
implied away.

`detach()` removes the shield, the stylesheet and every blocker; a session reset
and `destroy()` both go through it.

### Verified against a real browser

jsdom has no `elementsFromPoint`, so the unit tests can only prove that the
capture phase blocks events and that the shield element toggles. Neither shows
that a real browser stops the page from being hovered. `scripts/capture-probe-e2e.mjs`
drives real `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` at a real
frozen target and reports:

```
shield: {"shieldPointerEvents":"auto","hostPointerEvents":"none",
         "elementUnderCursor":"DIV","hoverMatches":false}
page saw keys: []
```

`hoverMatches: false` is the load-bearing assertion. The same run also shows the
click retargeting to `DIV#` — the shield doing its job — while `activeCount`
reaches 3, which is the proof that the coordinate hit test keeps selection
working underneath it.

## 9h. Source pointers (level 2)

Level 1 is the `file:line` the Bridge reports from the target's own metadata
(`data-inspector-file` / `data-inspector-line`). Level 2 is the text around it:
saying *where* to edit is only half of being able to.

### The location travels with the change log

`ChangeLogEntry` and `ChangeLogGroup` in `src/preview/proposal.ts` now carry
`file` and `line`, taken from the citation the change was applied to, and a group
takes the first entry that has one rather than the first entry seen. Both are
`null` when the target reported no location, because the Bridge never fabricates a
location and neither does the log — an invented path would be worse than none.

### Why the supervisor, and not the target's dev server

`GET /api/target/source?path=&line=&before=&after=` is a read-only route on the
Supervisor's existing status server (`scripts/with-launcher.mjs`), delegating to
`readSourceWindow` / `handleSourceRequest` in `scripts/source-reader.mjs` and
reusing the same origin gate and CORS helper as every other status route. Status
codes: 403 for an unauthorized origin, with no CORS header; 400 for a missing
path; 404 for every other refusal.

The choice of host is the load-bearing part. `GET <target>/src/Button.tsx` against
a Vite target answers with the **transformed** module, so the `file:line` already
in hand would not line up with the returned text; the proxy emits no CORS
headers, so the body would not even be readable; and the repository has no way to
know whether the target is Vite at all. The Supervisor already knows the project
root (`job.dir`) and already gates its routes to the active App origin, which is
exactly the authority this needs.

### Containment

This is the project's **first** path-joining code, so it sets the convention
rather than reusing one. The path arrives from the target page, which makes it
untrusted input, and the file it names lives outside this repository. The rules,
in order:

- Relative and forward-slashed only. No `..`, no drive letter, no UNC prefix, no
  leading slash, no control characters, and a length cap. A segment starting with
  a dot is refused at any depth as well, which is what keeps a `.env` unreadable
  through a route whose whole job is reading source.
- The extension must be on a short allowlist of source files. This is not a
  security boundary on its own — a `.ts` can hold anything — it keeps the route
  from becoming a general file reader.
- `node_modules` and `.git` are refused at **any** depth, because a monorepo puts
  the first under every package and a `segments[0]` test would miss it.
- Containment is re-checked after `realpathSync`. That is the check that actually
  matters: a link inside the project is the obvious way to walk out of it.
- A regular file, within a 512KB cap.

The window is capped at 400 lines and **recentred** on the cited line when the cap
bites. Keeping the start of the slice would produce a window that does not contain
the line it was asked for, and a heading that lies is worse than a shorter quote.

### What the app does with it

`src/target/source.ts` fetches and sanitizes: every control character is stripped
**except the tab**, so Korean, emoji and box-drawing characters survive intact and
a tab is still indentation — and a newline cannot, because the host splits lines
before sending, so one embedded newline would render as two lines while the
heading counted one. `src/target/sourceCache.ts` holds a 12-entry LRU keyed
`path:line` with in-flight de-duplication, and caches failures too: retrying a
`no-path` on every render of a popup is a loop, and a target with no metadata will
not grow one mid-session.

The window surfaces in two places. The proposal document —
`buildProposalDocument(session, snippets?)` — gains a `**참고 위치**` line and a
fenced block of up to 40 lines; the details popup gains a `Source` block with line
numbers. The document's fence is sized to one more than the longest backtick run
inside the quote, because a source line containing ``` is a valid CommonMark
closer and a bare three-backtick fence would end the block early, rendering the
rest of the quote as prose. A quote cut at the 40-line cap says so in the document.

A target that sets no `data-inspector-file` gets nothing, and no request is made
at all — the empty path short-circuits before the fetch. The popup stays
**silent** on every other failure too: no "unavailable" row, because the Location
row above it is already the place that says where the component lives, and a row
that repeats it is noise.