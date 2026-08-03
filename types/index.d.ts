// partforge — the app entry (DOM).
//
// This entry pulls in the three.js viewer and the control panel, so it must NOT
// be imported from a part's build functions; those run in a Web Worker and take
// their geometry helpers from "partforge/geometry".

import type { BackendName } from "./kernel.js";
import type { ParamValue, PartDefinition } from "./part.js";

export * from "./kernel.js";
export * from "./part.js";

/** A canonical capture angle. */
export type CanonicalView = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom";

/** Which pane a narrow layout shows. `null` hands selection back to partforge. */
export type HostPane = "stage" | "rail" | null;

/** An export file format. STEP is routed to OCCT automatically. */
export type ExportFormat = "stl" | "step" | "3mf";

/**
 * A semantic click result: which sub-part was hit, where (in the sub-part's own
 * local frame, quantized to 0.01 mm), the snapped surface normal, and only the
 * params that sub-part actually reads.
 */
export interface Selection {
  subPart: string;
  point: [number, number, number];
  normal: [number, number, number];
  params: Record<string, ParamValue>;
  /** Present when the hit surface carries a `Solid.label()` name. */
  feature?: { label: string };
}

export interface PickEvent {
  selection: Selection;
  /** The feature label, the sub-part's label, or the sub-part name. */
  label: string;
  /** The selection formatted for an LLM prompt. */
  prompt: string;
  /** The selection formatted as a compact token. */
  token: string;
}

/** Fired once per completed build. NOT fired for a pose-only edit. */
export type BuildEvent =
  | { status: "success"; ms?: number }
  | { status: "error"; error: string };

/** The bytes of a finished export, when the host supplies its own download sink. */
export interface DownloadPayload {
  data: ArrayBuffer | Uint8Array;
  filename: string;
  mime: string;
}

/**
 * Element references. Every entry falls back to the legacy global-ID lookup
 * (`#app`, `#controls`, `#panel`, `#part`, `#download*`, `#status`/`#busy`/
 * `#phase`, `#pause`/`#reframe`/`#theme`/`#cutaway`/`#rail-toggle`), resolved
 * exactly once at mount.
 */
export interface MountElements {
  /** The viewer canvas host (`#app`). */
  viewer?: HTMLElement | null;
  /** The control panel host (`#controls`). */
  controls?: HTMLElement | null;
  /** The full-height controls rail (`#panel`). */
  rail?: HTMLElement | null;
  /**
   * The positioned `.pf-shell` ancestor. Only needed when the rail is not a
   * direct child of it — the resize seam is positioned against
   * `rail.parentElement` otherwise.
   */
  shell?: HTMLElement | null;
  status?: {
    status?: HTMLElement | null;
    busy?: HTMLElement | null;
    phase?: HTMLElement | null;
  };
  /** The view-tab bar (`#part`); leave the element empty, `mount` fills it. */
  tabs?: HTMLElement | null;
  exports?: {
    stl?: HTMLElement | null;
    step?: HTMLElement | null;
    threeMf?: HTMLElement | null;
  };
  chrome?: {
    pause?: HTMLElement | null;
    reframe?: HTMLElement | null;
    theme?: HTMLElement | null;
    cutaway?: HTMLElement | null;
    railToggle?: HTMLElement | null;
  };
}

export interface MountOptions {
  /**
   * Spawns a geometry worker. Called once per backend with `name` as the
   * Worker's `name` option. The `new Worker(new URL(...))` call must stay
   * inline in the app module or Vite will not bundle the worker.
   */
  createWorker: (name: BackendName) => Worker;
  elements?: MountElements;
  onBuild?: (event: BuildEvent) => void;
  /**
   * Programmatic click-to-select. Supplying this arms the picker permanently
   * and takes precedence over the `?pick` and `?pickserver` URL modes.
   */
  onPick?: (event: PickEvent) => void;
  /** Receive exported bytes instead of partforge's own DOM download. */
  onDownload?: (file: DownloadPayload) => void;
  /** @deprecated alias for `elements.viewer`. */
  container?: HTMLElement | null;
  /** @deprecated alias for `elements.controls`. */
  controls?: HTMLElement | null;
}

export interface ExportPartsOptions {
  /** Sub-part names, as `listExportableParts()` reports them. */
  parts: string[];
  format: ExportFormat;
  /** Mesh quality for STL/3MF. Defaults to `"print"`. */
  quality?: "preview" | "print";
  onProgress?: (phase: string) => void;
}

export interface CaptureCurrentOptions {
  /** Long-edge resolution in px, clamped into `[256, maxTextureSize]`. */
  size?: number;
  /** Keep the floor grid so the capture matches the on-screen look. */
  hideGrid?: boolean;
  /** JPEG quality, 0..1. */
  quality?: number;
}

/** The runtime handle `mount()` returns. See `makeHandle` in src/framework/mount.js. */
export interface PartRuntime {
  /** Resolves on the first successful build of the default view; rejects on a first-build error. */
  ready: Promise<void>;
  /** Full teardown of everything this mount created. Idempotent. */
  dispose(): void;
  /**
   * Programmatic param entry point (the animation hook). Same change path as a
   * slider edit: pose-only changes repair synchronously, geometry changes fall
   * through to the regen loop.
   */
  setParams(partial: Record<string, ParamValue>): void;
  /**
   * Canonical-angle captures (fixed poses, framed to the visible assembly,
   * 1024², grid hidden) — sized for feeding a vision model. Defaults to
   * `["iso", "front", "top"]`; unknown names are dropped.
   */
  captureViews(viewNames?: CanonicalView[] | string[]): Array<{ view: string; dataUrl: string }>;
  /**
   * One offscreen render of the user's CURRENT framing at a chosen resolution —
   * the showcase capture. Returns a `data:image/jpeg;base64,…` string, or `null`
   * when disposed or nothing is built yet. Never throws.
   */
  captureCurrent(opts?: CaptureCurrentOptions): string | null;
  /**
   * Park/unpark the viewer: stops the render loop and releases the drawing
   * buffer and cached capture target. For a host that hides the canvas without
   * unmounting it. Captures still work while parked. Safe after `dispose()`.
   */
  setActive(active: boolean): void;
  /**
   * Subscribe to WebGL context loss — i.e. the GPU or the OS gave up — so a host
   * can say so rather than showing a dead canvas. The listener takes no
   * arguments (the underlying event is consumed and `preventDefault`ed).
   * Returns an unsubscribe.
   */
  onContextLost(listener: () => void): () => void;
  /**
   * Every exportable sub-part — excludes any `exportable: false` part, respects
   * each part's `enabled(params)` — INDEPENDENT of the active view.
   */
  listExportableParts(): Array<{ name: string; label: string }>;
  /**
   * Headless export of a chosen subset. Resolves once the file is written
   * (handed to your `onDownload` sink, or downloaded directly); rejects on
   * build/export failure or an empty selection.
   */
  exportParts(opts: ExportPartsOptions): Promise<void>;
  /**
   * Narrow-layout pane selection, for a host that draws its own tab bar.
   * `null` hands selection back to partforge's built-in bar.
   */
  setHostPane(pane: HostPane): void;
}

/** Mount a full parametric-part app from a `PartDefinition`. */
export function mount(part: PartDefinition, options: MountOptions): PartRuntime;

/**
 * The sub-parts a view shows: declared in the view and `enabled` for these
 * params, in `Object.keys(part.parts)` order. Handy for app-side view logic.
 */
export function viewSubParts(
  part: PartDefinition,
  view: string,
  params: Record<string, ParamValue>,
): string[];
