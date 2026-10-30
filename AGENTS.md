# AGENTS.md

Static p5.js sketch. No package manager, build, bundler, lint, or test runner — do not invent `npm`/`pnpm` commands.

## Run and verify

- Open `index.html` in a browser, or serve the folder: `python -m http.server 8000`.
- Serve over `http://localhost` rather than opening `file://`: `getUserMedia` and the ml5 model download need a real origin.
- p5.js 2.3.3 and ml5 1.4.0 load from CDNs, so the page requires internet and fails offline.
- Verification is manual: load the page, allow the camera, and watch the browser console. `node --check <file>` is the only static check available.

### Known console noise (harmless, not fixable here)

These three messages appear in Firefox only and reproduce with an empty p5 sketch:

1. `Use of the orientation sensor is deprecated.` and `Use of the motion sensor is deprecated.` — p5 core registers `deviceorientation` and `devicemotion` listeners on every sketch (`presetup` in `p5.min.js`). Maintainers closed this as not fixable ([p5.js#3918](https://github.com/processing/p5.js/issues/3918)); still present in p5 2.3.4. Chrome and Edge do not log it.
2. `Source map error … URL constructor: is not a valid URL` pointing at `wasm:…/ml5.min.js` — Firefox DevTools failing to resolve a source map for the WebAssembly module compiled by the tfjs backend bundled inside ml5. Only appears with DevTools open; disable "JS source maps" in DevTools settings to hide it.

Do not add workarounds for these; there is no code change that removes them.

## Load order matters

`index.html` loads classic scripts, in this order: `js/gamelogic.js`, `js/handpose.js`, `js/ui.js`, then `sketch.js`.

- Everything runs in p5 global mode: no `type="module"`, no `import`/`export`. Share state through globals and keep `setup`/`draw` as global function declarations in `sketch.js`.
- A new script must be added to `index.html` before `sketch.js` if `sketch.js` depends on it.

## Architecture: three owners, three files

`sketch.js` is bootstrap only: create canvas, instantiate modules, wire them in `setup`/`draw`. Keep it that way; put behavior in the module that owns it.

| File | Owns | Must not |
| --- | --- | --- |
| `js/handpose.js` | Camera, ml5 model, normalized hand data, skeleton rendering | Know about game rules |
| `js/gamelogic.js` | Game state and rules, reading hand data | Touch the camera, ml5, or p5 drawing calls |
| `js/ui.js` | HUD, text, menus, on-screen input | Decide game rules |

`js/handpose.js` is implemented: `HandTracker` (camera + model + normalization) and `HandRenderer` (draws sticks and joint circles, no camera image). `js/gamelogic.js` and `js/ui.js` are still empty.

### Hand data contract

`HandTracker` publishes:

- `status` — `'loading'` | `'ready'` | `'error:camera'` | `'error:model'`; `start()` never throws, it sets `status`
- `hands` — `Hand[]`, each with `handedness`, `confidence`, `keypoints` (21 × `{x, y, z, name}`), and `named` for direct lookup (`named.index_finger_tip`)
- `connections` — index pairs for the skeleton, from `handPose.getConnections()`
- `aspect` — video width/height

Coordinates are **normalized 0..1 and already mirrored** (selfie). Do not re-scale or re-mirror in consumers; multiply by whatever space you need. `HandRenderer` applies letterboxing so the skeleton is not stretched on non-4:3 windows — consumers comparing distances should account for `aspect` the same way.

## ml5 gotchas

- `ml5.handPose()` is **shape-dependent**, and this is the trap that cost two debugging sessions. ml5 1.4.0 calls `p5Utils.setupP5Integration(...)`: if p5 exposes `p5.prototype.registerMethod` (all of p5 1.x) it keeps factories synchronous; otherwise it rewrites every factory as `(...args) => r.ready.then(() => r)` — a **Promise**. p5 2.3.3 has no `registerMethod` (`grep registerMethod p5.min.js` → 0 matches), so on this stack `ml5.handPose()` returns `Promise<instance>`, not the instance. Always `await` it and then await `instance.ready` when present; `js/handpose.js::_resolveModel` does exactly that and throws a typed error if the result has no `detectStart()`.
- Never describe a model failure as "no internet" in the UI. `HandRenderer._drawStatus` shows `tracker.error` verbatim because a guess hides the actual exception.
- `setup()` is intentionally **not** async: `tracker.start()` is fire-and-forget so `draw()` renders the loading/error state instead of showing nothing while the model downloads. Never block setup on the model.
- Detection runs in ml5's own loop, so never call `estimateHands`/`detect` yourself in `draw()`.

## Current state

- The `<video>` element is created in JS and never shown, so never use `createCapture` (it appends a visible camera element).
- `HandTracker.start()` never throws; failures surface as `status` plus a `console.error` prefixed `[handpose]`.

## Styling

- `style.css` is a reset: `* { margin: 0; padding: 0 }`, `box-sizing: border-box`, and `canvas { display: block; max-width: 100% }`. p5 appends its canvas to `<body>`, so the reset clamps it to the viewport width.

## Git

- Local branches: `main`, `develop`, and the active `feature/handpose`. No remote is configured; nothing is pushed anywhere.
