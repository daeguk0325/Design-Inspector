# Preview invariants

The contract the Preview runtime holds itself to, and where each clause is
pinned. Written before the Design Engine, so that anything which changes one of
these has to change a test that says so out loud.

A row is **held** when an executable assertion fails if it breaks, and
**open** when the current behaviour is wrong and only recorded. Open rows are
not a backlog of nice-to-haves: each one is a way the system can currently lie
to the user, and the Design Engine is not allowed to make any of them worse.

| # | Invariant | State | Pinned by |
|---|---|---|---|
| I1 | A transaction the Bridge partly applied stays `enabled` and reachable by undo | held | `controller.test.tsx` "I1: a partially applied transaction stays enabled and undoable" |
| I2 | A transaction with nothing applied is `rejected` and disabled | held | `controller.test.tsx` "I2: a fully rejected transaction is not offered to undo" |
| I3 | A transaction is never applied to a target it was not authored for; it becomes `stale-binding` | held | `controller.test.tsx` "I3: a transaction from a different target is marked stale and never posted", `useSessions.test.tsx` "I3: marks live transactions stale…" |
| I4 | `stale-binding` is never retried by the rebind effect | held | `controller.test.tsx` "I4: a stale transaction is not retried by the rebind effect" |
| I5 | A→B→A re-applies, and the claim set does not grow across rebinds | held | `controller.test.tsx` "re-applies to the target after an A→B→A round trip", "I5: repeated binds and switches keep applying exactly once per binding" |
| I6 | A v2 operation on a v1 Bridge is refused with a reason, not silently dropped | held | `controller.test.tsx` "I6", "I8" |
| I7 | A declarations-only transaction still applies on a v1 Bridge | held | `controller.test.tsx` "I7" |
| I8 | A command is never posted into a binding owned by another session | held | `controller.test.tsx` "refuses to post a transaction into a binding owned by another session" |
| I9 | Every transaction records its producer | held | `controller.test.tsx` "I9" |
| I10 | A transaction with no `producer` loads as `chat` and keeps its history | held | `models.test.ts` "I10" |
| I11 | A malformed `producer` falls back to `chat` rather than dropping the record | held | `models.test.ts` "I11", "I11b" |
| I12 | A load that dropped persisted transactions says so | held | `store.test.ts` "I12", "I12b", "I12c" |
| I13 | The transaction cap and the model-block cap are separate numbers | held | `models.test.ts` "I13", "I13b" |
| **I14** | **Undoing a `text`/`replaceText` operation restores the original Text node's identity, not a copy** | **open** | — |
| **I15** | **A session reset cancels a preview that is already in flight** | **open** | — |
| **I16** | **The App learns when the Bridge trims a layer, instead of the record silently claiming `applied`** | **open** | — |
| **I17** | **CSS precedence between two layers is deterministic after the specificity ladder saturates** | **open** | — |
| **I18** | **"Copy for Agent" reflects live, unexported preview state** | **open** | — |
| **I19** | **A shadow-DOM component reports `unbound` distinguishably from one that genuinely has no match** | **open** | — |
| **I20** | **A CSP that blocks the preview stylesheet is reported, not reported as `applied`** | **open** | — |

## Why the open ones matter before a Design Engine exists

**I14 — text node identity.** `replayPreviewTextRestores` calls
`document.createTextNode(record.data)` and re-inserts a *new* node. `element:
"remove"` restores the original element by reference, so the asymmetry is
specific to text. Anything holding the original node — a framework's internal
reference, a `NodeIterator`, an app variable — is left pointing at a detached
orphan. A design system that re-lays out text will hit this; nothing in a
restyle-only pass ever does.

**I15 — in-flight applies survive a session reset.** `routeEpoch` is incremented
in exactly one place, `syncRoute`, and `handleSessionReset` never calls it, so a
reset re-sends the *unchanged* epoch. `dropStalePreviews` filters on
`pending.routeEpoch < nextEpoch`, strictly, so nothing is cancelled. A
`PREVIEW_APPLY` issued before the reset still resolves, and the App records
`applied` for a layer the reset already destroyed. This is precisely the class
`dropStalePreviews` exists to prevent; the epoch is the wrong instrument for a
session reset.

**I16 — silent trim.** `trimPreviewLayers` evicts the oldest layer past 16 per
binding or 128 globally and sends nothing. The evicted transaction keeps
`status: 'applied'`, so `undo` returns `no-op` for a change the page never had.
The per-binding budget is now enforced App-side, which is what makes the condition
unreachable for chat traffic — but nothing prevents a single transaction from
pushing a binding over 16 layers, and the App cannot see the layer count at all.

**I17 — specificity saturation.** `specificity = min(3 + previewOrdinal, 12)`,
and `previewOrdinal` is never reset. After roughly nine applies every layer
sits at 12 and precedence falls out of `<style>` tree order instead. A theme
applied as a transaction stack will cross that threshold in normal use.

**I18 — export silence.** `buildAgentPrompt` never reads `previewTransactions`,
so its output is byte-identical whether zero or five previews are live and
undecided, and `handleCopyAgent` has no guard on preview state. The agent is
handed a page description that silently omits what the user is looking at.
`producer` is what makes this decidable: without it there is no way to ask
"which live changes would not be in this export".

**I19 — shadow DOM.** `buildPreviewIndex` uses `document.querySelectorAll('*')`,
which does not pierce shadow roots, and the App has no signal distinguishing
"not found" from "not visible to this scan".

**I20 — CSP.** `createStyleLayer` prefers an adopted sheet and falls back to a
`<style nonce>`; a policy that blocks either produces no exception. The Bridge
reports `applied`, the App records `applied`, and the page is mutated — marks are
set regardless — while nothing renders.

## Limits, and why they are duplicated rather than negotiated

| Limit | App | Bridge |
|---|---|---|
| anchors per model block | `MAX_PREVIEW_RULES` 12 (`contract.ts`) | n/a — the model never reaches the Bridge directly |
| anchors per transaction | `MAX_TRANSACTION_CHANGES` 256 (`transaction.ts`) | `PREVIEW_MAX_CHANGES` 256 |
| declarations per anchor | `MAX_CSS_DECLARATIONS` 12 (`cssPolicy.ts`) | `PREVIEW_MAX_DECLARATIONS` 12 |
| allowed CSS properties | `cssPolicy.ts` allowlist **and** denylist | `PREVIEW_ALLOWED_PROPERTIES` allowlist only |
| layers per binding | 16 (enforced App-side) | `PREVIEW_MAX_LAYERS_PER_BINDING` 16 |
| layers global | — | `PREVIEW_MAX_LAYERS` 128 |

The CSS duplication is deliberate and documented in both files. The rest is
drift waiting to happen: the App's `MAX_TRANSACTION_CHANGES` and the Bridge's
`PREVIEW_MAX_CHANGES` are the same product limit in two places with nothing
tying them together. I13 pins that they disagree with the model-block cap on
purpose; it does not pin that the two 256s agree. A test that reads the Bridge
source and compares the constants is the obvious next step.

Note also that the Bridge advertises `maxPreviewChanges` and
`previewSchemaVersion` in `capabilities`, so those two are observable from the
App; the layer caps are not in `capabilities` and cannot be.

## Not invariants, but adjacent facts worth keeping

- `revertTo` resets every live transaction and disables it. Nothing replays the
  earlier transactions back in order afterwards, so a rewind is a rollback with
  no redo.
- `anchorHintsMatch` returning `false` on a `getAttribute` throw is a *safe*
  default, unlike most of the silent catches in the Bridge's preview path.
- The Bridge never writes `data-inspector-component`; it only reads it
  (`bridge:1849`). In the HTML path `component` is never null — it falls back to
  the tag name — so family resolution is meaningless until the target application
  authors the attribute. That is a contract with the target, not an assumption
  the Inspector can make for it.
