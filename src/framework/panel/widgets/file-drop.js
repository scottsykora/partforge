// The shared drop target behind `type: "image"`, `type: "vector"` and
// `type: "font"` (Tasks 6, 8, 9) — NOT itself a control. It owns no param key
// and draws no label/row of its own; it turns a dropped, picked or pasted
// file into either a host-stored source string or the converted artifact, and
// hands that to `onSource`. Kind-agnostic for classification and upload: the
// registry (`../../ingest/registry.js`) already knows what each kind accepts
// and how to convert it, and `classify`/`convertFor`/the `onAssetUpload`
// branch never look past `kind` as an opaque string.
//
// ONE named exception, in exactly two places, both explained where they
// occur: `convertedArtifact` and the "no host hook" branch of `handle()`
// both check `kind === "vector"` by name, because a vector's "no host hook"
// delivery is the PARSED document object, not bytes like every other kind
// (task-9 addendum, Ruling D) — that asymmetry has to live somewhere, and
// singling it out here is more honest than pretending every kind still ends
// up looking the same.
//
// `mountDrop` (bottom of this file) is the widget-facing half: wiring
// `makeFileDrop`'s output to a control's own `params[node.key]` and error
// surface is the same ~25 lines in widgets/image.js, widgets/font.js and
// widgets/vector.js — two copies were defensible as deliberate mirroring
// (Tasks 6, 8); a third (Task 9) is where a shared helper wins (task-9
// addendum, Ruling L). All three widgets call it instead of keeping their own
// `mountXDrop`/`makeDropError` pair.
//
// Before this file there was no drag-and-drop, file picker, or paste
// affordance anywhere in the panel (design doc, "Evidence" §1) — this is new
// code, not an extraction.
//
// MAIN-THREAD ONLY, like font.js/image.js: it reaches the real converters
// (canvas decode for images, paper.js for vectors) only through the
// registry's `convert` thunks, so a part with no such control never pays for
// either, and neither is reachable from the geometry worker's import closure
// (test/worker-layering.test.js walks the registry itself; this file adds
// nothing new to that surface).
import { classify, convertFor, rowFor } from "../../ingest/registry.js";

// A generous but bounded cap, checked against `file.size` — BEFORE even
// `file.arrayBuffer()` is called, let alone conversion — so an oversize file
// is never read into memory just to be rejected. 25 MB comfortably covers a
// photo, a font family file or a hand-drawn SVG; nothing this framework
// ingests is legitimately bigger, and letting a bigger one through would
// decode on the main thread with no progress UI. The design doc left the
// exact number to this task (open item 2) — this is that pick.
const MAX_BYTES = 25 * 1024 * 1024;

const bytesLabel = (n) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

// media type -> a short human noun, for a refusal message naming what a file
// actually IS (spec §5: "names what works"). Kept local and small: the
// registry's own `label`s already read as sentences ("an image (PNG, JPG or
// WebP)"), not nouns, so they are the wrong shape for "X is a ␣ file".
const MEDIA_NOUN = {
  "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/svg+xml": "SVG",
  "font/otf": "OTF", "font/ttf": "TTF", "font/woff2": "WOFF2",
};

// Compose the refusal message from a failed `classify()`. Two shapes, both
// naming the actual file:
// - the registry knows another slot that WOULD take it (`suggestKind`) ->
//   name where it belongs, e.g. "logo.svg is artwork (SVG) ... try the
//   Artwork control instead" — the exact case the registry's `suggestKind`
//   exists for. Uses the row's own `name` (a display name, e.g. "Artwork"),
//   never the internal `kind` key (e.g. "vector") — the key is an
//   implementation detail the registry happens to use for lookups, not
//   something a control is labelled.
// - it knows only what THIS slot accepts — either the bytes are unrecognised,
//   or they are a real, named format that just has no home anywhere (WOFF2)
//   -> say what works, point nowhere.
function refusalMessage(filename, kind, { mediaType, suggestKind }) {
  const needLabel = rowFor(kind).label;
  if (suggestKind) {
    const haveRow = rowFor(suggestKind);
    return `"${filename}" is ${haveRow.label} — this control accepts ${needLabel}. Try the ${haveRow.name} control instead.`;
  }
  const noun = mediaType && MEDIA_NOUN[mediaType];
  const what = noun ? `a ${noun} file` : "not a file this control recognises";
  return `"${filename}" is ${what} — this control accepts ${needLabel}.`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// `ambient` is for a control that already has a visible way in — the font
// control's catalog button, say. A labelled drop zone under it would spend rail
// height repeating the same offer, so the ambient form carries no hint, no click
// target and no place in the tab order: it is an overlay that shows itself only
// while a file is over it (see `.file-drop-ambient` in app.css). Dropping still
// works, it is simply not advertised.
//
// The click path is dropped rather than hidden, deliberately: an invisible
// overlay that still swallowed clicks would eat the button underneath it, which
// is the one affordance ambient mode exists to protect.
export function makeFileDrop({ kind, key, onSource, onError, onAssetUpload, ambient = false }) {
  const row = rowFor(kind);
  const wrap = el("div", ambient ? "file-drop file-drop-ambient" : "file-drop");
  if (!ambient) {
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "button");
    // Two hints, swapped by CSS on `.has-thumb`. The empty-state one is the only
    // thing in an empty tile; the replace one takes over once a preview fills it.
    // Without the second, a tile showing a part's declared artwork — now the
    // state a control OPENS in — carried no instruction at all, because the
    // first is hidden the moment a thumbnail appears.
    wrap.append(el("span", "file-drop-hint", `Drop ${row?.label ?? "a file"} here, or click to choose`));
    wrap.append(el("span", "file-drop-hint file-drop-hint-replace", "Drop to replace, or click to choose"));
  }

  // The click/keyboard path to the same handler a drop uses. Hidden rather
  // than absent: a real `<input type="file">` is what gives this a native
  // "Choose File" affordance and OS-level type filtering (`accept`), neither
  // of which is worth hand-rolling.
  // Ambient mode has no click path, so it gets no input at all — an unused one
  // would still be focusable in some browsers and would show up to a screen
  // reader as a second, unlabelled file control.
  let input = null;
  if (!ambient) {
    input = document.createElement("input");
    input.type = "file";
    input.className = "file-drop-input";
    input.hidden = true;
    if (row?.accepts?.length) input.accept = row.accepts.join(",");
    wrap.append(input);
  }

  // The converted artifact from the most recently accepted drop — a Blob (or,
  // for a `convert: null` kind like font, the original File, which already IS
  // the artifact since nothing transforms it). Kept so a failed
  // `onAssetUpload` can be retried without re-reading and re-converting the
  // file the user already dropped: that reconvert — a canvas decode, a
  // paper.js import — is the whole reason this exists rather than just
  // re-deriving it from the DOM on retry.
  let converted = null;

  // One AbortController for every listener this widget adds (created here,
  // ahead of `handle`, so `handle` can close over `signal` — see `stale()`
  // below). `dispose()` is a single `abort()` rather than a hand-maintained
  // list of pairs to get wrong. font-picker.js:49 explains why removal
  // matters: a stray listener keeps this whole closure (and everything it
  // closes over — `onSource`, `onAssetUpload`, eventually a live `params`)
  // alive long after the panel that created it is gone.
  const ac = new AbortController();
  const { signal } = ac;

  // `handle()` is a multi-await chain (read -> classify -> convert -> upload),
  // and two things can happen while it's suspended: the widget can be
  // disposed (a panel rebuild tore this control down), or a SECOND drop can
  // land before the first finishes (a slow first file, a fast second one).
  // Neither must be allowed to write into `converted` or fire `onSource`/
  // `onError` after the fact — a disposed widget has no live closure to write
  // into safely, and a superseded drop must not clobber the newer one's
  // result (the user's most recent drop has to win). `generation` is bumped
  // on every `handle()` call; `stale()` is true once either reason applies,
  // and every callback site below is gated on it.
  let generation = 0;

  // The argument shape a converter wants differs by kind — imageToPng wants
  // the Blob itself, ingestSvg wants the decoded SVG text — so this is the one
  // place that looks past "kind" as an opaque string. A `convert: null` row
  // (font) needs no call at all: the dropped file is already the artifact.
  //
  // Returns `{ blob, doc }`: `blob` is what an `onAssetUpload` host hook gets
  // (a host uploads bytes, not a live object) and what `lastBlob()` retains
  // for a retry; `doc` is set only for "vector", where it is the PARSED
  // partforge-vector document `ingestSvg` already produced. `blob` still
  // carries the JSON-serialized form for the upload path, but `handle()`
  // below delivers `doc` — never the serialized bytes — to `onSource` when
  // there is no host hook to upload to (task-9 addendum, Ruling D: the
  // resolver already accepts an in-tree parsed object directly, so
  // serializing it only for the resolver to re-parse would be pure waste).
  async function convertedArtifact(file, mediaType) {
    const convert = await convertFor(kind, mediaType);
    if (!convert) return { blob: file, doc: undefined };
    if (kind === "vector") {
      const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
      const doc = convert(text, { source: file.name });
      return { blob: new Blob([JSON.stringify(doc)], { type: "application/json" }), doc };
    }
    return { blob: await convert(file), doc: undefined };
  }

  async function handle(file) {
    const myGen = ++generation;
    const stale = () => signal.aborted || myGen !== generation;

    // Checked against `file.size` alone — no read yet — so an oversize file
    // never gets fully buffered into memory just to be rejected.
    if (file.size > MAX_BYTES) {
      onError?.(`"${file.name}" is ${bytesLabel(file.size)} — over the ${bytesLabel(MAX_BYTES)} limit.`);
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (stale()) return;

    const result = classify(bytes, kind);
    if (!result.ok) {
      onError?.(refusalMessage(file.name, kind, result));
      return;
    }

    let artifact;
    try {
      artifact = await convertedArtifact(file, result.mediaType);
    } catch (err) {
      if (stale()) return;
      // Names the file and the stage (spec §5) — a malformed SVG must not
      // read as a partforge bug.
      onError?.(`"${file.name}" could not be converted: ${err.message}`);
      return;
    }
    if (stale()) return;             // a newer drop already won — don't clobber its `converted`
    converted = artifact.blob; // retained from here on, success or not — see the field comment above

    if (onAssetUpload) {
      try {
        // `key` is the PARAM the drop landed on. A host needs it to give a
        // control a stable destination of its own — partforge-cloud derives
        // one file path per key, so re-dropping replaces that control's
        // artwork in place instead of accumulating files it must later
        // reconcile against the part. Purely informational to partforge:
        // the hook still answers with a source string and nothing here
        // reads the key back.
        const source = await onAssetUpload(artifact.blob, { kind, key, filename: file.name });
        if (stale()) return;
        // A host hook that resolves to anything but a non-empty string —
        // `undefined`, an object, `""` — is a contract violation, not a
        // source: writing it into the param would corrupt the part rather
        // than fail loudly.
        if (typeof source !== "string" || !source) {
          onError?.(`"${file.name}" was converted, but the upload hook returned ${JSON.stringify(source)} instead of a source string.`);
          return;
        }
        onSource?.(source);
      } catch (err) {
        if (stale()) return;
        // The artifact stays in `converted` — a retry (the host re-driving
        // onAssetUpload, e.g. from a "try again" button) costs a network
        // call, not a reconvert.
        onError?.(`"${file.name}" converted, but the upload failed: ${err.message}. Retry — it doesn't need reconverting.`);
      }
      return;
    }

    // No host hook. For "vector" the artifact IS the parsed document object —
    // deliver that directly, never its serialized bytes (task-9 addendum,
    // Ruling D; see `convertedArtifact` above).
    if (kind === "vector") {
      onSource?.(artifact.doc);
      return;
    }

    // Every other kind: the bytes themselves are the param value. This is the
    // path the partforge-cloud sandbox needs because it cannot fetch URLs —
    // correct and expected, not a degraded fallback (see font.js/image.js's
    // own byte-valued param handling for the downstream half of this).
    const ab = await artifact.blob.arrayBuffer();
    if (stale()) return;
    onSource?.(ab);
  }

  async function handleFiles(files) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    if (list.length > 1) {
      // Silently dropping the rest would be worse than a one-line note
      // (spec §5) — reported, but the first file still proceeds below.
      onError?.(`${list.length} files were dropped — using only the first, "${list[0].name}".`);
    }
    await handle(list[0]);
  }

  const onDrop = (e) => {
    e.preventDefault();
    wrap.classList.remove("file-drop-over");
    handleFiles(e.dataTransfer?.files);
  };
  const onDragOver = (e) => { e.preventDefault(); wrap.classList.add("file-drop-over"); };
  const onDragLeave = () => wrap.classList.remove("file-drop-over");
  const onClick = () => input.click();
  const onKeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
  const onChange = () => { handleFiles(input.files); input.value = ""; }; // same file twice must still fire `change`
  // Paste is the third affordance the feature exists to add (design doc,
  // "Evidence" §1: "no drag-and-drop, file picker, or paste affordance
  // anywhere in the panel") — a clipboard image/font/SVG lands the same way a
  // drop does.
  const onPaste = (e) => { if (e.clipboardData?.files?.length) handleFiles(e.clipboardData.files); };

  // `ac`/`signal` were created above, ahead of `handle()` — every listener
  // below shares the same one.
  wrap.addEventListener("drop", onDrop, { signal });
  wrap.addEventListener("dragover", onDragOver, { signal });
  wrap.addEventListener("dragleave", onDragLeave, { signal });
  wrap.addEventListener("paste", onPaste, { signal });
  // Click, keyboard and the input's own change only exist when there is an input
  // to open — ambient mode is drop-and-paste only, so that the control's real
  // button keeps every click.
  if (input) {
    wrap.addEventListener("click", onClick, { signal });
    wrap.addEventListener("keydown", onKeydown, { signal });
    input.addEventListener("change", onChange, { signal });
  }

  return {
    el: wrap,
    dispose: () => ac.abort(),
    lastBlob: () => converted,
  };
}

// The widget-facing wiring: mounts a `makeFileDrop` for one control and binds
// it to `params[node.key]`, including the control's own error surface (a
// hidden-by-default line under the drop target, filled verbatim with
// whatever `onError` composed — spec: "do not rewrite or wrap it; render
// it"). Marks the drop element `data-pf-drop` (the tests select on it).
//
// `onRender` is the widget's own repaint (`paintField`/`paint`) — called
// after a successful drop so the field/button reflects the new value
// immediately, the same way a catalog picker's `onPicked` already does.
// `onChange`/`onCommit` are then fired in that order, mirroring every other
// widget's own edit path (render.js wires them: `onChange` marks the section
// Custom and re-applies condition state, `onCommit` is the "the user finished
// an interaction" signal that triggers a rebuild).
//
// Returns `{ el, errorEl, dispose }` rather than appending anything itself —
// the caller still owns layout (where the drop target and error line sit
// relative to the field/button), only the wiring is shared.
export function mountDrop(kind, { params, node, onAssetUpload, onChange, onCommit, onRender, ambient = false }) {
  const errorEl = el("div", "file-drop-error");
  errorEl.hidden = true;

  const drop = makeFileDrop({
    kind,
    key: node.key,
    ambient,
    onAssetUpload,
    onSource: (source) => {
      errorEl.hidden = true;
      errorEl.textContent = "";
      params[node.key] = source;
      onRender?.();
      onChange?.();
      onCommit?.();
    },
    onError: (message) => {
      errorEl.hidden = false;
      errorEl.textContent = message;
    },
  });
  drop.el.setAttribute("data-pf-drop", "");

  return { el: drop.el, errorEl, dispose: () => drop.dispose() };
}
