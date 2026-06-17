# Drum Machine

[![Live app](https://img.shields.io/badge/live-Drum%20Machine-2ea44f?logo=github)](https://scottsykora.github.io/Drum-Machine/)
[![Deploy to GitHub Pages](https://github.com/scottsykora/Drum-Machine/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/scottsykora/Drum-Machine/actions/workflows/deploy-pages.yml)

**▶ Open the app: https://scottsykora.github.io/Drum-Machine/**

Drum Machine is a free, browser-based tool for designing **capstan-drive drums** —
the rope-and-pulley parts at the heart of a cable-driven robot joint. Pick your
rope, reduction ratio, and motor, hit **Generate**, spin the 3D model around, and
download print-ready **STL/STEP** files. No CAD software to install, no account,
nothing to pay.

It's aimed at one very practical goal: making it easy to print the parts for a
**single capstan test joint** so you can try the technique on your bench before
committing to a whole robot.

---

## What's a capstan drive?

A capstan drive is a beautifully simple speed reducer: a thin **rope** wraps a
few turns around a small **motor drum**, runs across to a large **output drum**,
and is anchored at both ends. When the motor turns, the rope pulls the big drum
around. The ratio of the two drum diameters *is* your gear reduction — no gear
teeth anywhere.

That simplicity buys a remarkable list of properties that are hard to get any
other way, especially on a hobby budget:

- **Zero backlash** — the rope is always in tension, so there's no slop on
  reversal. Great for precise, repeatable motion.
- **High torque transparency / backdrivability** — you can feel forces *through*
  the joint, which is exactly what you want for force control, teleoperation, and
  safe human-robot contact.
- **Low inertia & quiet** — no heavy gear trains; it runs nearly silently.
- **Cheap and 3D-printable** — the drums print on a normal FDM printer; the
  "gears" are literally rope.

The catch is that good capstan drums are *fiddly geometry*: helical rope grooves
at the right pitch and lead angle, a mid-rope anchor so the rope can't walk,
bearing seats, motor mounts, end stops. Getting those right by hand in CAD is
exactly the tedious part this tool automates.

## Why start with a test joint?

Before you design a 5-DOF arm around capstan drives, you want to answer a few
questions with your own printer, rope, and motor:

- Does my print + rope + groove actually hit the torque the math promises?
- Is my construction technique sound (rope tension, anchoring, bearing fit)?
- How does it *feel* — stiffness, backdrivability, end stops?

A **test joint** is the cheapest way to learn all of that. Drum Machine lets you
dial in your exact parameters, regenerate in seconds, and print a matched
small-drum + big-drum + tensioner set — then build one joint, load-test it, and
iterate. Change the rope diameter or reduction and you get a new, correct part
set instantly, instead of re-deriving helix math in CAD.

## Using the app

1. Open **https://scottsykora.github.io/Drum-Machine/**.
2. Choose a part: **Small drum**, **Big drum**, or **Both**.
3. Start from the **presets** (the easy path), or expand **Advanced** for full
   control over rope, reduction, motor mount, grooves, bearing seats, end stops,
   and the load-test socket.
4. Hit **Generate** to build the real 3D solid, then **Download STL** (print) or
   **STEP** (edit in CAD).

Everything runs locally in your browser — the geometry is computed with a real
CAD kernel (OpenCASCADE, via WebAssembly), so the exports are true solids, not
meshes.

## Credit & inspiration — go support these makers

This tool stands entirely on the shoulders of the people who made maker-scale
capstan drives a thing. If you find Drum Machine useful, the best thing you can
do is **go watch their work and support it directly.**

### Aaed Musa — the reason any of us are doing this

Aaed Musa has done more than anyone to bring capstan drives to hobbyist and
professional roboticists, through his open-source designs and his (genuinely
excellent) build videos. Start here:

- 🎥 **CARA** — *[I Built a Robot Dog Using... Rope?](https://www.youtube.com/watch?v=8s9TjRz01fo)*
- 🎥 **CARA 2.0** — *[I Built an Even Better Robot Dog](https://www.youtube.com/watch?v=GFLa1b1juUo)*
- ▶️ YouTube: [@aaedmusa](https://youtube.com/@aaedmusa) · 📸 Instagram: [@aaedmusayt](https://www.instagram.com/aaedmusayt/) · 🌐 [aaedmusa.com](https://www.aaedmusa.com/projects)
- 🧩 Open-source [Capstan-Drive](https://github.com/aaedmusa/Capstan-Drive) reference design

**Subscribe to his Patreon → https://patreon.com/aaedmusayt.** He shares full
project files there, including an **[8:1 Capstan Drive Test Stand](https://www.patreon.com/posts/8-1-capstan-test-133816478)**
and the **[CARA 2.0 build files](https://www.patreon.com/posts/cara-2-0-project-155326366)** —
which are what the default parameters in this tool are modeled after. If this
project saved you time, that Patreon is where the thanks should go.

### Other cool capstan / cable-driven projects

- **The 5439 Workshop** — 3D-printable rope-based actuators for a bipedal robot.
  [YouTube](https://www.youtube.com/@The5439Workshop) ·
  [Hackaday writeup](https://hackaday.com/2026/01/05/tying-up-loose-ends-on-a-rope-based-robot-actuator/)
- **Stanley** — a capstan-based quadruped kit.
  [Hackaday.io project](https://hackaday.io/project/176726-stanley-the-capstan-based-quadruped-kit) ·
  [Hackaday writeup](https://hackaday.com/2021/08/07/capstan-drive-is-pulling-the-strings-on-this-dynamic-quadruped/)
- **Barrett WAM** — the classic cable-driven research arm that proved how
  transparent and backdrivable tendon/cable transmissions can be.

---

## Develop

The app is a static, no-backend web app: a [Replicad](https://replicad.xyz)
(OpenCASCADE-in-WebAssembly) CAD kernel running in a Web Worker, a
[three.js](https://threejs.org) viewer, bundled with [Vite](https://vitejs.dev).
Generation does a helical groove **sweep** plus a **fuzzy boolean cut**
(`src/fuzzy-cut.js`) so the cut stays robust even on the full ~23-turn drum, then
meshes a coarse preview (fine mesh runs only on STL download).

```bash
nvm use            # Node 24 — pinned in .nvmrc (system default may be older)
npm install
npm run dev        # http://localhost:5173
npm run build      # static site → dist/
```

Pushing to `main` auto-deploys to the live site via GitHub Actions
(`.github/workflows/deploy-pages.yml`).

| Path | What |
|---|---|
| `index.html`, `src/main.js` | app entry + viewer wiring |
| `src/params.js` | parameter schema (presets + advanced controls) |
| `src/controls.js` | builds the control panel from the schema |
| `src/drum.js`, `src/drum-worker.js` | drum geometry; runs in a Web Worker |
| `src/fuzzy-cut.js` | robust boolean cut via the raw OCCT kernel |
| `scripts/groove-test.mjs` | headless helical-groove sanity check |

### What's modeled

- **Small drum:** helical rope groove · mid-rope lock weave hole · blind
  motor-shaft bore · bearing support stub · motor-mount flange + bolt holes.
- **Big drum:** worm-style stripe grooves · center bore · bearing seats (both
  faces) · link bolt circle · travel end stops · load-test socket (1/2" PVC) ·
  sliding-block tensioner pockets (each toggleable).
- **Tensioner block:** captured-nut jack-screw block, exported alongside the drum.
- **Both:** drums placed at the true center distance with the motor tucked under.

Not yet modeled: sector (<360°) drums and rope-lock bend-relief channels.

## License & attribution

The capstan-drive concept and the reference geometry this tool is modeled on are
the work of **[Aaed Musa](https://www.aaedmusa.com/)** (and the broader community
above). This generator is an independent tool for producing printable parts;
please support the original creators via the links above.
