// The one arithmetic behind the stage's two "clearance" custom properties —
// --pf-viewbar-clear (mount.js) and --pf-anim-clear (animation-controls.js):
// how far up from the stage's bottom edge a floating bar reaches, so chrome
// that stacks above it (the view cube, a host's status pills) can sit clear.
//
// A bar with NO BOX claims nothing. `getBoundingClientRect()` on a
// `display: none` element is all zeros, and `stageRect.bottom - 0` is the
// stage's bottom edge in viewport pixels — the whole stage height, or more.
// Publishing that would fling everything stacked on the bar off the top of
// the stage. The inline-style check the anim bar used to make
// (`bar.style.display === "none"`) only saw its own hide; a host hiding the
// bar from a stylesheet (partforge-cloud's part-open sheet does exactly that
// to #viewbar and .pf-anim-bar) left the publishers measuring the zero rect.
// The rect itself is the test: hidden by anyone, for any reason, it is empty.
export function stageClearFor(stageRect, barRect) {
  if (!barRect || barRect.height === 0) return 0;
  return Math.max(0, Math.round(stageRect.bottom - barRect.top));
}
