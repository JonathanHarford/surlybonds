# Surly Bonds

A browser toy to illustrate my favorite Fun Fact: it takes more energy to fall into the sun than it does to leave the solar system.

Controls: `←` `→` to rotate, `↑` to thrust. `R` to reset. Touch-friendly.

## Files

| File | Purpose |
|------|---------|
| `+page.svelte` | Game logic, physics, input, and all draw calls |
| `+page.ts` | Disables SvelteKit SSR |
| `gl-bloom.ts` | WebGL2 bloom renderer (neon glow effect) |
| `gl-font.ts` | All-caps vector stroke font for HUD text |

## Setup

### Standalone

```bash
npm install
npm run dev
```

`src/routes/` contains symlinks to the root files so this repo is runnable on its own.

### As a submodule

Drop (or mount as a git submodule) into `src/routes/` of any SvelteKit project. The route files at the repo root are picked up directly.

## How it works

**Physics** — Newtonian gravity with RK4 integration. The orbit shape (ellipse or hyperbola) is computed analytically each frame from the eccentricity vector and rendered as a conic section. When periapsis ≤ sun radius the orbit turns red; when eccentricity ≥ 1 you've reached escape velocity.

**Rendering** — Everything draws through a WebGL2 bloom pipeline: geometry goes into an offscreen scene texture, three tiers of progressive-downsample Gaussian blur produce the glow, and a composite shader adds sharp core + glow to the canvas. The font is a custom all-caps stroke font on a 3×3 grid, rendered as GL lines + point sprites.

**Scores** — Best fuel cost for escape and collision are stored in `localStorage`.

## License

See [LICENSE](LICENSE).
