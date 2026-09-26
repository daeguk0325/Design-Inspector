# Architecture — Design Inspector Tool MVP

## 1. State ownership (§3)

| Owner | Owns | Files |
|---|---|---|
| Bridge (target runtime or proxy-injected compatibility runtime) | `inspectorFrozen`, inspector mode, live `SelectionRecord`s (incl. measured `styleFacts` §9e), live highlight/label DOM, `connectionId`, `documentGeneration`, `routeEpoch`, runtime CSS preview layers, selectionId→logical anchor registry | `bridge/vera-inspector-bridge.ts`, `scripts/target-proxy.mjs` |
| App A | session selection intent (`persistedActiveSelectionIds`), chat history, pins + pin order, settings, localStorage, export inputs, preview transactions (`apply`/`undo`/`reset` + decisions), style-fact sanitizing for the state boundary | `src/hooks/*`, `src/state/*`, `src/persistence/*`, `src/preview/*`, `src/style/*` |

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
  Export order is separately `order` (first-added); pin order is `pinnedAt`.
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
- Freeze ON: listeners attach (capture-phase click interception with
  `preventDefault`/`stopPropagation`, submit prevention), hover/select active.
- Freeze OFF: canonical live reset — listeners detached, hover cleared, live
  highlights + registry cleared, snapshot emitted; App A drops the active set,
  history preserved. Only `Escape` (clear hover) and the Freeze shortcut are
  handled; no blanket keyboard blocking (Tab/input/accessibility unaffected).

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
 └─ 127.0.0.1:5199 status + App-origin-gated proxy control API
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
  state coordination. Iframe reloads and Bridge HMR restart HELLO retries, and a
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

## 6b. Structured CSS preview (auto, runtime only)

- The English system role asks the model to append exactly one fenced block
  tagged `design-inspector-preview` containing a JSON array of
  `{ selectorId, declarations }`. The visible answer remains Korean; the block
  is stripped before rendering.
- Streaming sidecar parsing buffers split tokens, tolerates truncation, and
  only yields a payload for a strictly valid, schema-conformant, allow-listed
  JSON array (`src/preview/sidecar.ts`, `src/preview/cssPolicy.ts`). Invalid,
  oversized, truncated, or errored responses simply produce no preview.
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
deduped reconciled active (first-added order) + pins (`pinnedAt` order) +
fixed template, `\n` endings, exactly one trailing newline. No AI call.
`buildRawTranscript` is the separate untransformed export.

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
decisions are persisted.

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
answer "what colour is this?" with a hex code instead of "cannot tell".

### Shape and ownership

`SelectionRecord.styleFacts?` is an **optional** field, added the same way
`anchor?` is. No new wire type, no new message, no new capability flag. The flow
is Bridge → snapshot → app state → `CitationSnapshot` → prompt / details panel.

The Bridge is authoritative and extracts live from the DOM in `recordPayload()`:
one `getComputedStyle` and one `getBoundingClientRect` per record, on every
emit. There is deliberately **no per-record cache** — a route change nulls
`rec.target`, so the facts invalidate themselves, and `emitSnapshot` only fires
on discrete events (freeze, mode, route, selection, request), never on
hover/scroll/resize, so the live read is cheap.

### The Bridge cannot import from `src/`

`scripts/target-proxy.mjs` transpiles each Bridge source with
`ts.transpileModule` and concatenates them. There is no module resolution, so
the allowlist, the defaults table, the sanitizer, and the colour conversion all
live inline in `bridge/vera-inspector-bridge.ts`. `src/style/properties.ts` keeps
a second, stricter copy for the app side. **The duplication is the trust
boundary**: the target controls the payload, so the app drops any property it
does not recognise rather than trusting the Bridge's list.

### Defaults are per property, not one global list

Omitting defaults is what leaves only the surprising values, but "is this the
default" is a per-property question: `0px` is unremarkable on `margin-top` and a
finding on `padding-top`, and `display: block` is noise on nearly every selected
element while `inline-flex` is the whole point. `STYLE_FACT_DEFAULTS` and
`STYLE_FACT_ZERO_DEFAULT_PROPS` encode that; a single flat list cannot.

56 longhand properties in five groups (color 10, typography 11, box 19, layout
12, motion 4). Longhands only — a shorthand would hide a single differing side.
`background-color: rgba(0,0,0,0)` is filtered, which matters because otherwise
every element reports a transparent background.

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
3. **State** — `sanitizeStyleFacts` runs again in `citationFromRecord`, because
   `CitationSnapshot` is persisted on both user and assistant messages and would
   otherwise multiply across a session. A 1,200-char per-record budget drops
   whole groups (motion first, colour last) rather than truncating values: a
   missing `filter` is honest, a half-written one is not.

In the prompt the block is fenced as ```` ```untrusted-evidence ````, the system
prompt names style values and element text as untrusted evidence explicitly, and
the block precedes the images — the measurements are authoritative, the image is
reference.

### The facts never enter the agent export

`src/export/serialize.ts` is AI-free and its output is pasted into another tool
by a human, with no untrusted-evidence framing. Style facts stay in the model
transmission only; `serialize.test.ts` pins that.

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
