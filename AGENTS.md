# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Surly Bonds is a single-page SvelteKit browser game. A spacecraft starts in a circular orbit; the player uses thrust to either escape the sun's gravity or crash into it. The question in the title is the whole mechanic.

There are four source files:

- [+page.svelte](+page.svelte) — game logic, physics loop, input handling, all drawing calls
- [+page.ts](+page.ts) — disables SSR (`export const ssr = false`)
- [gl-bloom.ts](gl-bloom.ts) — `BloomRenderer` class: WebGL2 pipeline that draws sharp geometry into a scene FBO then runs a 3-tier progressive-downsample blur (½ → ¼ → ⅛ res) and composites sharp core + glow tiers to the canvas
- [gl-font.ts](gl-font.ts) — all-caps vector stroke font on a 3×3 grid; exports `textLines`, `textPoints`, `measureText`, `CELL_W`, `CELL_H`

## How this fits into a SvelteKit project

These files live under `src/routes/` in a SvelteKit app (they were extracted from a project called "portfy"). To run locally you need a SvelteKit host project with Vite. There is no `package.json` here; add these files to an existing SvelteKit repo.

## Architecture

**Rendering pipeline** (`gl-bloom.ts`)

Geometry is accumulated during each frame via `renderer.lines()`, `renderer.strip()`, `renderer.points()`, and `renderer.fillRect()` — all written into `sceneFBO`. `endFrame()` drives the blur chain and composites to the canvas. Bloom tuning constants (`BLUR_SPREAD_T*`, `BLOOM_W_T*`) are at the top of the file.

All text in the game goes through `gl-font.ts` — two calls per string: `textLines()` for the stroke segments (`renderer.lines()`), then `textPoints()` for the vertex dots that make the neon look crisp (`renderer.points()`).

**Physics** (`+page.svelte`)

Gravity is Newtonian (`GM = 900_000`). Integration uses RK4 (`integrateGravity`). Orbital shape is computed analytically each frame via vis-viva / eccentricity vector (`computeConic`), then tessellated into screen points (`conicPoints`) for rendering. The conic changes color to RED when periapsis ≤ `SUN_R` (collision imminent) or eccentricity ≥ 1 (escape velocity reached).

**Coordinate system**

Physics space is centred on the sun at (0, 0). Screen space has the sun at canvas centre (`cx, cy`). Ship screen position = `(cx + px, cy + py)`.

**Input**

Keyboard (`ArrowLeft/Right/Up`) and touch. The screen is divided into three touch zones: left third = rotate CCW, right third = rotate CW, bottom centre strip = thrust. The RESET button in the bottom-right corner is hit-tested in CSS pixels against geometry measured in physical pixels, requiring the DPR correction in `isResetZone`.

**Scores**

Best escape and best collision fuel costs are persisted to `localStorage` under keys `ev_best_escape` and `ev_best_collision`.
