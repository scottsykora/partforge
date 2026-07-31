// The narrow-layout pane tab bar. Below RAIL_NARROW_BREAKPOINT there is no room
// for a rail beside the viewer, so the shell shows exactly ONE pane and this bar
// chooses which. chrome.css owns the layout, keyed on the data-pf-pane attribute
// this module writes onto .pf-shell; a missing attribute reads as "stage", so
// the layout is already correct before any of this runs.
//
// Two independent reasons the bar can be absent, and they are deliberately
// handled by different mechanisms:
//   * WIDTH — above the breakpoint the rail sits beside the viewer and no tab is
//     needed. That is pure CSS (.pf-tabbar { display: none }). There is no JS
//     media-query bookkeeping in this file at all, and no resize listener.
//   * A HOST owns pane selection — partforge-cloud draws its own bottom bar at
//     the window level and drives this layout through setHostPane(). Then our
//     bar is `hidden` and only the host's choice writes data-pf-pane.
//
// State is in-memory: a fresh load starts on the stage, and nothing persists.
// Which pane you are looking at right now is not a preference.
//
// The DOM is created here, so no host markup declares it — same contract as
// rail.js's seam, and the reason this composes with partforge-cloud's
// hand-built sandbox scaffold without that scaffold knowing anything about it.
const SVG_NS = "http://www.w3.org/2000/svg";

// Hand-authored in lucide's 24x24 / 2px-stroke idiom so these sit beside
// rail.js's toggle icon without introducing a second icon vocabulary (and
// without a dependency for three glyphs). `stroke="currentColor"` is
// load-bearing: it is how each icon picks up its button's themed colour, and
// the accent colour of the pressed state, with no icon-specific CSS anywhere.
const ICONS = {
  // A box: the part itself.
  stage: [
    "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
    "m3.3 7 8.7 5 8.7-5",
    "M12 22V12",
  ],
  // Three horizontal sliders: the parameter controls.
  rail: [
    "M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3",
    "M14 2v4", "M8 10v4", "M16 18v4",
  ],
};
const LABELS = { stage: "3D", rail: "Controls" };
const PANES = ["stage", "rail"];

function buildIcon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  // Decorative: every button carries a visible text label already.
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// role="group" + aria-pressed, NOT role="tablist": a real tablist owes its tabs
// aria-controls'd tabpanels, and .pf-stage / .pf-rail are host-built DOM this
// module does not own and must not relabel. Two pressed-state buttons describe
// what this actually is without promising semantics we cannot honour.
//
// Everything is optional, like attachRail: with no shell to manage this returns
// a no-op handle, so a legacy id-only page or a host that lays the framework out
// itself (embed-test.html) is unaffected — including its setHostPane, which
// stays a callable no-op so mount()'s handle shape never varies.
export function attachMobileTabs({ shell, stage, rail } = {}) {
  if (!shell || !stage || !rail) {
    return { setHostPane: () => {}, detach: () => {} };
  }

  let pane = "stage"; // the standalone user's choice
  let hostPane = null; // a host's lease over that choice, while non-null

  const bar = document.createElement("div");
  bar.className = "pf-tabbar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Viewer panes");
  const buttons = new Map();
  for (const p of PANES) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pfPaneTab = p;
    button.title = LABELS[p];
    button.append(buildIcon(ICONS[p]));
    const label = document.createElement("span");
    label.textContent = LABELS[p];
    button.append(label);
    bar.append(button);
    buttons.set(p, button);
  }
  // Last child of the shell: in the narrow layout .pf-shell is a column, so the
  // bar lands under whichever pane is showing. Above the breakpoint it is
  // display:none and its position in the flex row is moot.
  shell.append(bar);

  function apply() {
    const active = hostPane ?? pane;
    shell.dataset.pfPane = active;
    for (const [p, button] of buttons) {
      button.setAttribute("aria-pressed", String(p === active));
    }
    // A host that owns pane selection draws its own control; ours would be a
    // second, competing one.
    bar.hidden = hostPane !== null;
  }

  // Delegated, so the icon <svg>/<span> inside a button resolve to the button.
  const onClick = (e) => {
    const next = e.target?.closest?.("[data-pf-pane-tab]")?.dataset?.pfPaneTab;
    if (!PANES.includes(next)) return;
    pane = next;
    apply();
  };
  bar.addEventListener("click", onClick);
  apply();

  return {
    // 'stage' | 'rail' takes the lease; anything else (including null) releases
    // it and restores the standalone bar and the user's own last choice.
    setHostPane: (next) => {
      hostPane = PANES.includes(next) ? next : null;
      apply();
    },
    detach: () => {
      bar.removeEventListener("click", onClick);
      bar.remove();
      delete shell.dataset.pfPane;
    },
  };
}
