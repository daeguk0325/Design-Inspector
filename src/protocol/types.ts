// Design Inspector Tool — protocol type definitions.
// Spec: BUILD_PROMPT v4.3 §§ 4,5,6,7,8. App A MUST NOT invent selectionIds.

export const PROTOCOL_VERSION = 1 as const;

export type InspectorMode = 'html' | '3d' | 'konva';
export type BridgeKind = 'native' | 'compatibility';

export interface BridgeCapabilities {
  selectionCrop: boolean;
  maxSelectionImages: number;
  maxImageBytes: number;
  maxImageDimension: number;
  maxImagePixels: number;
  cssPreview?: boolean;
  maxPreviewChanges?: number;
  maxPreviewPropertiesPerChange?: number;
  maxPreviewValueLength?: number;
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'stale'
  | 'disconnected'
  | 'timed_out';

export type SelectionState = 'active' | 'inactive';

export interface InspectorAnchor {
  elementKey: string;
  routeKey: string;
  mode: 'html';
  tagName: string;
  id: string;
  testId: string;
  path: string;
}

/**
 * Measured from the live DOM by the Bridge (§9e). Optional so a Bridge that
 * does not implement it — or a non-HTML mode, or a target that was navigated
 * away from — simply omits the field.
 *
 * Every string in here is controlled by the target page and reaches the model
 * prompt, so it is treated as untrusted evidence throughout.
 */
export interface StyleFactsGeometry {
  /** Viewport coordinates, as getBoundingClientRect reports them. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StyleFacts {
  /** CSS longhand name → computed value. Per-property defaults already omitted. */
  props: Record<string, string>;
  geometry?: StyleFactsGeometry;
  /** aria-label or element text, bounded. */
  label?: string;
  /** Nearest-first ancestor chain, e.g. ["header.nav", "main"]. */
  ancestors?: string[];
  tagName?: string;
}

export interface SelectionRecord {
  /** Bridge-issued only. App A never generates. */
  selectionId: string;
  /** Stable logical element identity within the current document generation. */
  elementKey: string;
  component: string | null;
  file: string | null;
  line: number | null;
  mode: InspectorMode;
  extra?: unknown;
  state: SelectionState;
  /** Monotonic first-added order for deterministic export. */
  order: number;
  anchor?: InspectorAnchor;
  styleFacts?: StyleFacts;
}

export interface LiveSnapshot {
  bridgeKind?: BridgeKind;
  capabilities?: BridgeCapabilities;
  connectionId: string;
  documentGeneration: string;
  inspectorFrozen: boolean;
  mode: InspectorMode;
  selections: SelectionRecord[];
  /** Canonical active display order: selectionIds in tray order. */
  activeOrder: string[];
  routeKey?: string;
  routeEpoch?: number;
}

export const APP_TO_BRIDGE_TYPES = [
  'VERA_INSPECTOR_HELLO',
  'VERA_INSPECTOR_FREEZE',
  'VERA_INSPECTOR_SET_MODE',
  'VERA_INSPECTOR_CLEAR_SELECTION',
  'VERA_INSPECTOR_RESELECT_SELECTION',
  'VERA_INSPECTOR_CLEAR_ALL',
  'VERA_INSPECTOR_CAPTURE_SELECTION',
  'VERA_INSPECTOR_REQUEST_SNAPSHOT',
  'VERA_INSPECTOR_PING',
  'VERA_INSPECTOR_SESSION_RESET',
  'VERA_INSPECTOR_PREVIEW_APPLY',
  'VERA_INSPECTOR_PREVIEW_UNDO',
  'VERA_INSPECTOR_PREVIEW_RESET',
] as const;

export type AppToBridgeType = (typeof APP_TO_BRIDGE_TYPES)[number];

export const BRIDGE_TO_APP_TYPES = [
  'VERA_INSPECTOR_HELLO_ACK',
  'VERA_INSPECTOR_SNAPSHOT',
  'VERA_INSPECTOR_FREEZE_ACK',
  'VERA_INSPECTOR_SELECTION',
  'VERA_INSPECTOR_CAPTURE_RESULT',
  'VERA_INSPECTOR_PONG',
  'VERA_INSPECTOR_ERROR',
  'VERA_INSPECTOR_SESSION_RESET_ACK',
  'VERA_INSPECTOR_PREVIEW_RESULT',
  'VERA_INSPECTOR_ROUTE_CHANGED',
  'VERA_INSPECTOR_BRIDGE_PRESENT',
] as const;

export type BridgeToAppType = (typeof BRIDGE_TO_APP_TYPES)[number];

export interface Envelope<TType extends string, TPayload> {
  protocolVersion: number;
  type: TType;
  connectionId: string;
  documentGeneration: string;
  requestId: string;
  sequence: number;
  payload: TPayload;
}

export interface HelloPayload {
  appOrigin: string;
}

export interface HelloAckPayload {
  bridgeKind?: BridgeKind;
  capabilities?: BridgeCapabilities;
  bridgeConnectionId: string;
  documentGeneration: string;
  veraUrl: string;
  routeKey?: string;
  routeEpoch?: number;
}

export interface FreezePayload {
  /** Explicit state-setting — never an ambiguous toggle (§9.2). */
  active: boolean;
}

export interface FreezeAckPayload {
  inspectorFrozen: boolean;
  mode: InspectorMode;
}

export interface SetModePayload {
  mode: InspectorMode;
}

export interface ClearSelectionPayload {
  selectionId: string;
}

/**
 * Re-activates a selection the app already knows about, keeping its
 * `selectionId` so the citation numbering is stable. An undo in the composer
 * needs the target highlight back, and the record is still held by the bridge.
 */
export interface ReselectSelectionPayload {
  selectionId: string;
}

export interface SnapshotPayload extends LiveSnapshot {}

export interface SelectionEventPayload {
  record: SelectionRecord;
  activeOrder: string[];
}

export interface CaptureSelectionPayload {
  selectionId: string;
}

export interface CaptureResultPayload {
  selectionId: string;
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  byteLength: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export type SessionResetPayload = Record<string, never>;

export interface SessionResetAckPayload {
  routeKey: string;
  routeEpoch: number;
}

export type PreviewOperation = 'apply' | 'undo' | 'reset';

export type PreviewResultStatus =
  | 'applied'
  | 'unbound'
  | 'ambiguous'
  | 'rejected'
  | 'undone'
  | 'reset'
  | 'no-op';

export type PreviewAnchorStatus = 'applied' | 'unbound' | 'ambiguous' | 'rejected';

export interface PreviewAnchorChange {
  anchor: InspectorAnchor;
  declarations: Record<string, string>;
}

export interface PreviewApplyPayload {
  bindingId: string;
  transactionId: string;
  changes: PreviewAnchorChange[];
}

export interface PreviewUndoResetPayload {
  bindingId: string;
  transactionId?: string;
  transactionIds?: string[];
}

export interface PreviewAnchorResult {
  elementKey: string;
  status: PreviewAnchorStatus;
  matchCount: number;
}

export interface PreviewResultPayload {
  bindingId: string;
  transactionId: string;
  operation: PreviewOperation;
  status: PreviewResultStatus;
  anchors: PreviewAnchorResult[];
  routeKey: string;
  routeEpoch: number;
}

export interface RouteChangedPayload {
  routeKey: string;
  routeEpoch: number;
}

export interface BridgePresentPayload {
  bridgeConnectionId: string;
  documentGeneration: string;
}

export type AppMessage = Envelope<AppToBridgeType, unknown>;
export type BridgeMessage = Envelope<BridgeToAppType, unknown>;
