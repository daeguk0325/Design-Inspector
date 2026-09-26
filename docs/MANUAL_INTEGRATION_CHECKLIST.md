# Manual Integration Checklist — inspected-app side

Optional target-side integrations for the Design Inspector Tool are listed
here. Basic HTML framing, freeze, selection, and citation transport are supplied
automatically by the proxy-injected compatibility Bridge. Nothing required for
that basic flow is hidden inside `bridge/vera-inspector-bridge.ts`. Spec:
BUILD_PROMPT v4.3 §§ 12, 13.

Naming note: this tool works with ANY local dev project ("target project" /
"inspected app"). "Vera" below is the current example project, not a
hard-coded assumption — the Launcher, supervisor, and protocol flows never
depend on the target's name or framework.

> The governing build prompt file (`Design_Inspector_Tool_BUILD_PROMPT_v4.2.md`)
> was not present in this workspace; the v4.3 text supplied in the task brief
> was treated as the normative contract. No spec file was created or modified.

## 0. Prerequisites

- Vera runs on an HTTP loopback origin with an explicit port, such as
  `http://127.0.0.1:3000` or `http://[::1]:3000`. The generic proxy intentionally
  rejects HTTPS, LAN/public hosts, credentials, and path/query/fragment targets.
- **No framing or Bridge change is required for basic HTML inspection.**
  Supervisor proxies the target through a dedicated isolated `127/8` origin,
  removes `X-Frame-Options`, rewrites CSP `frame-ancestors`, and injects a
  compatibility Bridge into the top-level HTML response. The target renders in
  the iframe and the Bridge provides Connected, Freeze, HTML hover/selection,
  and citations without target edits. The remaining steps are optional for
  authoritative source metadata, R3F/Konva hit-testing, and target-specific
  state coordination.

## 0b. Zero-IDE startup (Launcher + supervisor) — optional but recommended

No coding program or terminal typing is required for daily use.

1. Double-click `start-inspector.bat` in the Design Inspector folder (or run
   `npm run dev`). This starts App A, the Launcher window, and supervision.
2. The Launcher window appears (small, borderless, same theme and icon as
   App A). If the previously used target server is already running, it shows
   “실행 중 ✓” and closes itself.
3. Otherwise pick ANY project folder → **확인하고 시작**. The window
   minimizes and the dev server starts (recent targets are remembered —
   click one to reselect). Closing the window stops the server with it.
4. The browser opens with the resolved URL (`?target=`) already connected.
5. Target logs appear in the Launcher window and in App A (⋯ → Target dev
   server). Ctrl+C in the supervisor console also stops the target (App A
   coupling). Use `npm run dev:web` only when you want App A alone without
   the Launcher/supervisor.

**Verify:** Launcher confirm → minimized → browser opens at
`http://127.0.0.1:5173/?target=http://127.0.0.1:<port>&inspectorToken=<one-time>`;
App A consumes the token, requests a Supervisor-owned proxy route, strips the
handoff parameters from history, and renders the target without typing any URL;
close the Launcher window → the target and proxy ports stop answering and status
becomes idle; server crash → in-window error with retry.

## 0c. Automatic compatibility Bridge (default)

When the target is loaded through `npm run dev`, the proxy compiles
`bridge/vera-inspector-bridge.ts` and injects it into every top-level HTML
response before `</head>`. The injected runtime uses the exact App A origin,
owns selection IDs and freeze state, and is removed with the proxy route. No
target file, bundler, or server configuration changes are needed for ordinary
HTML buttons, links, forms, and DOM elements.

The proxy adds the exact inline script hash to enforced/report-only CSP and
rewrites CSP `sandbox` only on its isolated route. If the document uses an
unsupported encoding or exceeds the bounded document limit, the original page
is passed through and the App reports `Bridge unavailable` rather than showing
a false interactive state.

Manual Bridge installation below is optional. Use it when the target must
provide React source locations, R3F/Konva hit metadata, or coordinate its own
UI/store with Inspector state. A native Bridge takes precedence over the
compatibility runtime.## 1. Optional native Bridge import + initialization

**File:** Vera entry (e.g. `src/main.tsx` / `src/index.tsx`), once at startup.
**Purpose:** Start the inspector runtime that owns all live inspection state.
**Change:**

```ts
import { initVeraInspectorBridge } from './inspector/vera-inspector-bridge';

const bridge = initVeraInspectorBridge({
  appOrigin: 'http://127.0.0.1:5173', // EXACT App A origin, never "*"
});
```

**Why:** The native Bridge adds source resolution and target-owned hit-testing
  to the automatic compatibility runtime. The bridge validates
  `event.origin === appOrigin` and `event.source === window.parent`.
**Verify:** Start Vera through the Launcher → App A status becomes Connected; `bridge.getState()`
in the Vera console reports `{ frozen: false, ... }`.

The following target-specific steps are optional unless the project needs
authoritative source locations, R3F/Konva metadata, or its own UI/store freeze
coordination.

## 2. Zustand freeze state + actions (if Vera uses Zustand)

**File:** Vera inspector slice (e.g. `src/stores/inspectorStore.ts`).
**Purpose:** Let Vera's own UI cooperate with freeze (disable custom hovers).
**Change:** Add `inspectorFrozen: boolean` + `setInspectorFrozen(v: boolean)`.
Subscribe in the bridge init file:

```ts
// Poll or subscribe: when bridge state changes, mirror into Zustand.
setInterval(() => {
  const { frozen } = bridge.getState();
  useInspectorStore.getState().setInspectorFrozen(frozen);
}, 250);
```

**Why:** Vera's existing hover logic must be guardable (step 3).
**Verify:** Press Ctrl+Shift+F in Vera → store's `inspectorFrozen` flips.
(Alt+Shift+F still works as legacy fallback.)

## 3. Existing hover logic guard + clear

**File:** Wherever Vera implements its own hover highlight (canvas/portal/universal-board hover).
**Purpose:** Prevent double outlines and stale Vera hovers while frozen.
**Change:** Early-return when `inspectorFrozen === true`, and clear Vera hover
state on the transition `true → false`.
**Why:** Two competing hover systems produce flicker and wrong citations.
**Verify:** Freeze ON → only the dashed inspector outline appears; Freeze OFF →
Vera hover behaves exactly as before.

## 4. HTML source metadata (file/line citations)

**File:** Vera build config + components.
**Purpose:** Authoritative `component/file/line` citations (§12.2).
**Minimal change (no plugin):** add explicit attributes on inspectable roots:

```html
<div data-inspector-key="toolbar-save" data-inspector-component="Toolbar" data-inspector-file="src/components/Toolbar.tsx" data-inspector-line="42">
```

**Build-plugin option:** a Babel/SWC plugin that injects the same three
attributes from source location automatically (recommended for full coverage).
**Fallback (no metadata):** citations show `(location unavailable)` — the bridge
never fabricates locations (§25.2).
**Verify:** Select an element → citation shows the exact file:line; remove the
attributes → citation explicitly says unavailable instead of guessing.

## 5. Three.js / R3F metadata + access registration

**File:** Vera R3F canvas setup (e.g. `src/canvas/BoardCanvas.tsx`).
**Purpose:** Deterministic hit-testing inside the R3F event system (§12.3).
**Change:**

```ts
bridge.registerR3F({
  canvas: gl.domElement,
  getHits: (x, y) => {
    // Raycast here (you own the camera/scene); return hits ordered by priority:
    // nearest first; child metadata wins over parent groups; skip metadata-less
    // objects unless nothing else hit (then return explicit fallback entries).
    return hits.map((o) => ({
      elementKey: o.userData.inspectorKey, // stable key YOU assign
      component: o.userData.component ?? null,
      file: o.userData.file ?? null,
      line: o.userData.line ?? null,
    }));
  },
});
```

**Why:** A window-level DOM handler cannot reach R3F context; Vera must expose it.
**Verify:** Freeze + mode=3D → clicking a mesh yields its citation, numbered in order.

## 6. Konva metadata + stage registration

**File:** Vera Konva setup (e.g. `src/konva/Stage.tsx`).
**Purpose:** Deterministic Konva hit-testing (§12.4).
**Change:**

```ts
bridge.registerKonva({
  stage,
  getHits: (x, y) => {
    const node = stage.getIntersection({ x, y });
    if (!node) return [];
    return [{
      elementKey: node.getAttr('inspectorKey'),
      component: node.getAttr('inspectorComponent') ?? node.getClassName(),
      file: node.getAttr('inspectorFile') ?? null,
      line: node.getAttr('inspectorLine') ?? null,
    }];
  },
});
```

Multiple stages: register each; first hit wins. Dynamic shapes: assign
`inspectorKey` at creation time so reselection reuses the same `selectionId`.
**Verify:** mode=Konva → shape clicks cite the shape, not its parent group.

## 7. Camera / Scene / Stage access

Covered by steps 5–6: the registration callbacks **are** the access path. Do not
rely on globals like `window.__scene`. Document which canvas/stage each
registration belongs to if Vera has several.

## 8. Route / navigation boundary

**File:** Vera router (e.g. `src/router.tsx`).
**Purpose:** Live selections and applied CSS previews must follow SPA
navigation without going stale (§14.6).
**Change:** None required. The Bridge observes `pushState`/`replaceState`/
`popstate` and increments a `routeEpoch`; App A re-resolves each applied CSS
preview against its strong anchor (unique `id` or `data-testid`) on the new
route. If a preview resolves to zero or multiple elements it is reported
`Unbound`/`Ambiguous` and not force-applied. For full page loads the Bridge
re-initializes with a new `documentGeneration`; App A reconciles and drops
stale IDs automatically. Vera should only avoid caching `bridge.getState()`
across loads.
**Verify:** Apply a preview → navigate within the SPA → the preview re-applies
to the same logical component; full reload → `Connected` returns, history and
decisions persist, stale live IDs drop.

## 9. Cleanup / unmount lifecycle

The bridge exposes `bridge.destroy()` which removes all listeners, observers,
timers, and overlay DOM. Call it in HMR dispose / iframe teardown if Vera
hot-reloads the entry module:

```ts
if (import.meta.hot) import.meta.hot.dispose(() => bridge.destroy());
```

**Verify:** Freeze ON → HMR reload → no duplicate outlines, handshake recovers.

## 10. CSS / overlay host setup

None required. The bridge creates its own Shadow-DOM overlay host
(`z-index: 2147483647`, `pointer-events: none`), isolated from Tailwind
preflight and global `*` rules. Do not add global styles targeting
`[data-vera-inspector]`.

## 11. Environment / CORS

- No Vera server changes are needed for HTTP framing or WebSocket transport;
  Supervisor's dedicated local proxy handles those concerns.
- Hard-coded absolute URLs back to the upstream origin bypass the proxy. Prefer
  root-relative URLs (`/api`, `/assets`, `location.host`-based WebSockets) in the
  target's development configuration.
- For Ollama (App A side only): start Ollama with
  `OLLAMA_ORIGINS=http://127.0.0.1:5173` so direct browser `fetch` succeeds.

## 12. CSS preview (automatic, no target changes)

Auto CSS preview is a runtime-only feature. The Bridge owns a dedicated
`<style>` layer per applied transaction and injects it into the target document
at runtime. It never edits, writes, or hot-patches the target's source files,
bundler, or dev server, and there is no apply-to-source path. Undo, Reset, and
route rebinding all operate on that runtime layer. Nothing is required from the
target to enable it; the only requirement for a reliable rebind after
navigation is a stable `id` or `data-testid` on the element you want a preview
to follow.
