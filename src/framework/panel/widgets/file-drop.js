// The shared drop target behind `type: "image"`, `type: "vector"` and
// `type: "font"` (Tasks 6, 8, 9) — NOT itself a control. It owns no param key
// and draws no label/row of its own; it turns a dropped, picked or pasted
// file into either a host-stored source string or the converted bytes, and
// hands that to `onSource`. Kind-agnostic: the registry
// (`../../ingest/registry.js`) already knows what each kind accepts and how
// to convert it, so nothing here special-cases a media type by name — only
// the three-way argument shape a converter wants (see `convertedArtifact`)
// is kind-specific, and even that reduces to "image or not".
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

// A generous but bounded cap, checked on the RAW dropped bytes before any
// conversion runs — decoding is the expensive step (a canvas pass, a paper.js
// import), so the guard sits in front of it, not after. 25 MB comfortably
// covers a photo, a font family file or a hand-drawn SVG; nothing this
// framework ingests is legitimately bigger, and letting a bigger one through
// would decode on the main thread with no progress UI. The design doc left
// the exact number to this task (open item 2) — this is that pick.
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
//   vector control instead" — the exact case the registry's `suggestKind`
//   exists for.
// - it knows only what THIS slot accepts — either the bytes are unrecognised,
//   or they are a real, named format that just has no home anywhere (WOFF2)
//   -> say what works, point nowhere.
function refusalMessage(filename, kind, { mediaType, suggestKind }) {
  const needLabel = rowFor(kind).label;
  if (suggestKind) {
    const haveLabel = rowFor(suggestKind).label;
    return `"${filename}" is ${haveLabel} — this control accepts ${needLabel}. Try the ${suggestKind} control instead.`;
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

export function makeFileDrop({ kind, onSource, onError, onAssetUpload }) {
  const row = rowFor(kind);
  const wrap = el("div", "file-drop");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "button");
  const hint = el("span", "file-drop-hint", `Drop ${row?.label ?? "a file"} here, or click to choose`);
  wrap.append(hint);

  // The click/keyboard path to the same handler a drop uses. Hidden rather
  // than absent: a real `<input type="file">` is what gives this a native
  // "Choose File" affordance and OS-level type filtering (`accept`), neither
  // of which is worth hand-rolling.
  const input = document.createElement("input");
  input.type = "file";
  input.className = "file-drop-input";
  input.hidden = true;
  if (row?.accepts?.length) input.accept = row.accepts.join(",");
  wrap.append(input);

  // The converted artifact from the most recently accepted drop — a Blob (or,
  // for a `convert: null` kind like font, the original File, which already IS
  // the artifact since nothing transforms it). Kept so a failed
  // `onAssetUpload` can be retried without re-reading and re-converting the
  // file the user already dropped: that reconvert — a canvas decode, a
  // paper.js import — is the whole reason this exists rather than just
  // re-deriving it from the DOM on retry.
  let converted = null;

  // The argument shape a converter wants differs by kind — imageToPng wants
  // the Blob itself, ingestSvg wants the decoded SVG text — so this is the one
  // place that looks past "kind" as an opaque string. A `convert: null` row
  // (font) needs no call at all: the dropped file is already the artifact.
  async function convertedArtifact(file, mediaType) {
    const convert = await convertFor(kind, mediaType);
    if (!convert) return file;
    if (kind === "vector") {
      const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
      const doc = convert(text, { source: file.name });
      return new Blob([JSON.stringify(doc)], { type: "application/json" });
    }
    return convert(file);
  }

  async function handle(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      onError?.(`"${file.name}" is ${bytesLabel(bytes.length)} — over the ${bytesLabel(MAX_BYTES)} limit.`);
      return;
    }

    const result = classify(bytes, kind);
    if (!result.ok) {
      onError?.(refusalMessage(file.name, kind, result));
      return;
    }

    let artifact;
    try {
      artifact = await convertedArtifact(file, result.mediaType);
    } catch (err) {
      // Names the file and the stage (spec §5) — a malformed SVG must not
      // read as a partforge bug.
      onError?.(`"${file.name}" could not be converted: ${err.message}`);
      return;
    }
    converted = artifact; // retained from here on, success or not — see the field comment above

    if (onAssetUpload) {
      try {
        const source = await onAssetUpload(artifact, { kind, filename: file.name });
        onSource?.(source);
      } catch (err) {
        // The artifact stays in `converted` — a retry (the host re-driving
        // onAssetUpload, e.g. from a "try again" button) costs a network
        // call, not a reconvert.
        onError?.(`"${file.name}" converted, but the upload failed: ${err.message}. Retry — it doesn't need reconverting.`);
      }
      return;
    }

    // No host hook: the bytes themselves are the param value. This is the
    // path the partforge-cloud sandbox needs because it cannot fetch URLs —
    // correct and expected, not a degraded fallback (see font.js/image.js's
    // own byte-valued param handling for the downstream half of this).
    onSource?.(await artifact.arrayBuffer());
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

  // One AbortController for every listener this widget adds, so `dispose()`
  // is a single `abort()` rather than a hand-maintained list of pairs to get
  // wrong. font-picker.js:49 explains why this matters: a stray listener
  // keeps this whole closure (and everything it closes over — `onSource`,
  // `onAssetUpload`, eventually a live `params`) alive long after the panel
  // that created it is gone.
  const ac = new AbortController();
  const { signal } = ac;
  wrap.addEventListener("drop", onDrop, { signal });
  wrap.addEventListener("dragover", onDragOver, { signal });
  wrap.addEventListener("dragleave", onDragLeave, { signal });
  wrap.addEventListener("click", onClick, { signal });
  wrap.addEventListener("keydown", onKeydown, { signal });
  wrap.addEventListener("paste", onPaste, { signal });
  input.addEventListener("change", onChange, { signal });

  return {
    el: wrap,
    dispose: () => ac.abort(),
    lastBlob: () => converted,
  };
}
