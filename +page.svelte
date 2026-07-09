<script lang="ts">
	import { BloomRenderer, type RGB } from './gl-bloom';
	import { measureText, textLines, textPoints, CELL_H, CELL_W } from './gl-font';

	// ── constants ────────────────────────────────────────────────────────────────
	const GM = 900_000;
	const SUN_R = 22;
	const THRUST = 5;
	const ROT = Math.PI / 30;
	const TAU = Math.PI * 2;
	const GREEN: RGB = [0x39 / 255, 0xff / 255, 0x14 / 255];
	const RED: RGB   = [0xff / 255, 0x33 / 255, 0x33 / 255];
	const WHITE: RGB = [0xe8 / 255, 0xff / 255, 0xe4 / 255];
	const EXPLODE_FRAMES = 150;
	const FIRST_LINE = 'WHATS EASIER? BREAKING OUT OF ORBIT, OR'
	const LONGEST_LINE = 'SLIPPING GENTLY INTO THE SUNS FIERY EMBRACE?';

	// ── state ────────────────────────────────────────────────────────────────────
	let glCanvas  = $state<HTMLCanvasElement | null>(null);
	let renderer: BloomRenderer | null = null;

	let px = 0, py = 0, vx = 0, vy = 0;
	let shipAngle   = 0;
	let dvSpent     = 0;
	let initOrbitR  = 200; // set dynamically in reset()
	let exploded    = false;
	let explodeX    = 0, explodeY = 0, explodeAge = 0;
	let dangerDv: number | null = null;
	let prevDanger  = false;
	let prevEscaped = false;
	let bestEscape:    number | null = null;
	let bestCollision: number | null = null;

	// measured each frame in drawHud; used by isResetZone for hit testing
	let resetBtnW      = 80;
	let resetBtnSize   = 13; // font size in px
	let resetBtnMarginB = 0;

	// arrow geometry computed in drawHud, consumed by GL pass
	let arrowParams: { x: number; y: number; half: number; headBack: number; hw: number } | null = null;

	interface Spike { angle: number; rotSpeed: number; pulsePhase: number; pulseSpeed: number; visible: boolean; hideIn: number; showIn: number; }
	const sunSpikes: Spike[] = Array.from({ length: 8 }, (_, i) => ({
		angle:      (i / 8) * TAU,
		rotSpeed:   [-0.005, 0.031, -0.016, 0.044, 0.009, -0.027, 0.038, -0.013][i],
		pulsePhase: i * 0.75,
		pulseSpeed: [0.045, 0.07,  0.038, 0.08,  0.055, 0.065, 0.042, 0.072][i],
		visible:    true,
		hideIn:     70 + i * 28,
		showIn:     0,
	}));

	const keys      = new Set<string>();
	const touchKeys = new Map<number, string>();
	let rafId = 0;
	let stars: [number, number][] = [];

	// ── audio ─────────────────────────────────────────────────────────────────────
	let audioCtx:     AudioContext | null = null;
	let thrustSource: AudioBufferSourceNode | null = null;
	let thrustGain:   GainNode | null = null;
	let wasThrusting  = false;

	function startThrustSound() {
		if (thrustSource) return;
		if (!audioCtx) audioCtx = new AudioContext();
		const sr = audioCtx.sampleRate;
		const buf = audioCtx.createBuffer(1, sr * 2, sr);
		const d = buf.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

		thrustSource = audioCtx.createBufferSource();
		thrustSource.buffer = buf;
		thrustSource.loop = true;

		const lpf = audioCtx.createBiquadFilter();
		lpf.type = 'lowpass';
		lpf.frequency.value = 500;
		lpf.Q.value = 0.4;

		thrustGain = audioCtx.createGain();
		thrustGain.gain.value = 0;
		thrustGain.gain.setTargetAtTime(0.055, audioCtx.currentTime, 0.06);

		thrustSource.connect(lpf);
		lpf.connect(thrustGain);
		thrustGain.connect(audioCtx.destination);
		thrustSource.start();
	}

	function stopThrustSound() {
		if (!thrustGain || !thrustSource || !audioCtx) return;
		thrustGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.08);
		const src = thrustSource;
		thrustSource = null;
		thrustGain   = null;
		setTimeout(() => { try { src.stop(); src.disconnect(); } catch {} }, 400);
	}

	// ── stars ─────────────────────────────────────────────────────────────────────
	function generateStars(W: number, H: number) {
		stars = Array.from({ length: 110 }, () =>
			[Math.random() * W, Math.random() * H] as [number, number]
		);
	}

	// ── touch controls ────────────────────────────────────────────────────────────
	const ZX = 0.30;
	const ZY = 0.65;

	function touchZone(touch: Touch): string | null {
		if (!glCanvas) return null;
		const rect = glCanvas.getBoundingClientRect();
		const x = touch.clientX - rect.left;
		const y = touch.clientY - rect.top;
		const W = rect.width, H = rect.height;
		if (isResetZone(x, y, W, H)) return null;
		if (x < W * ZX)       return 'ArrowLeft';
		if (x > W * (1 - ZX)) return 'ArrowRight';
		if (y > H * ZY)        return 'ArrowUp';
		return null;
	}

	function applyTouches(changed: TouchList, active: boolean) {
		for (let i = 0; i < changed.length; i++) {
			const t = changed[i];
			touchKeys.delete(t.identifier);
			if (active) {
				const key = touchZone(t);
				if (key) touchKeys.set(t.identifier, key);
			}
		}
		for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp']) {
			if ([...touchKeys.values()].includes(k)) keys.add(k);
			else keys.delete(k);
		}
	}

	// ── orbital mechanics ─────────────────────────────────────────────────────────
	function gravity(x: number, y: number): [number, number] {
		const r = Math.hypot(x, y);
		if (r < 0.1) return [0, 0];
		const r3 = r * r * r;
		return [-GM * x / r3, -GM * y / r3];
	}

	function integrateGravity(dt: number) {
		const [k1vx, k1vy] = gravity(px, py);
		const k1px = vx, k1py = vy;
		const [k2vx, k2vy] = gravity(px + k1px * dt / 2, py + k1py * dt / 2);
		const k2px = vx + k1vx * dt / 2, k2py = vy + k1vy * dt / 2;
		const [k3vx, k3vy] = gravity(px + k2px * dt / 2, py + k2py * dt / 2);
		const k3px = vx + k2vx * dt / 2, k3py = vy + k2vy * dt / 2;
		const [k4vx, k4vy] = gravity(px + k3px * dt, py + k3py * dt);
		const k4px = vx + k3vx * dt, k4py = vy + k3vy * dt;
		px += (k1px + 2*k2px + 2*k3px + k4px) * dt / 6;
		py += (k1py + 2*k2py + 2*k3py + k4py) * dt / 6;
		vx += (k1vx + 2*k2vx + 2*k3vx + k4vx) * dt / 6;
		vy += (k1vy + 2*k2vy + 2*k3vy + k4vy) * dt / 6;
	}

	function reset() {
		const minDim = glCanvas ? Math.min(glCanvas.width, glCanvas.height) : 400;
		initOrbitR = minDim / 4; // diameter = half viewport
		px = 0; py = -initOrbitR;
		vx = Math.sqrt(GM / initOrbitR); vy = 0;
		shipAngle   = 0;
		dvSpent     = 0;
		exploded    = false;
		explodeAge  = 0;
		dangerDv    = null;
		prevDanger  = false;
		prevEscaped = false;
		stopThrustSound();
		wasThrusting = false;
	}

	interface Conic { e: number; l: number; periAngle: number; danger: boolean; escaped: boolean; }

	function computeConic(): Conic | null {
		const r = Math.hypot(px, py);
		if (r < 0.1) return null;
		const h  = px * vy - py * vx;
		const l  = (h * h) / GM;
		const ex = (vy * h) / GM - px / r;
		const ey = (-vx * h) / GM - py / r;
		const e  = Math.hypot(ex, ey);
		const periapsis = e < 1e-9 ? l : l / (1 + e);
		const escaped   = e >= 1;
		return { e, l, periAngle: Math.atan2(ey, ex), escaped, danger: escaped || periapsis <= SUN_R };
	}

	function conicPoints(c: Conic, cx: number, cy: number): number[] {
		const { e, l, periAngle } = c;
		const pts: number[] = [];
		const N = 40;
		if (e < 1) {
			for (let i = 0; i <= N; i++) {
				const theta = (i / N) * TAU;
				const r = l / (1 + e * Math.cos(theta - periAngle));
				if (r > 0) pts.push(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
			}
		} else {
			const halfOpen = Math.acos(-1 / e);
			const margin = 0.06;
			const tMin = periAngle - halfOpen + margin, tMax = periAngle + halfOpen - margin;
			for (let i = 0; i <= N; i++) {
				const theta = tMin + (i / N) * (tMax - tMin);
				const denom = 1 + e * Math.cos(theta - periAngle);
				if (denom < 0.01) continue;
				const r = l / denom;
				if (r > 0 && r < 5000) pts.push(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
			}
		}
		return pts;
	}

	// ── WebGL rendering ───────────────────────────────────────────────────────────

	function drawSun(cx: number, cy: number, alpha: number) {
		const segs: number[] = [];
		for (const s of sunSpikes) {
			s.angle      += s.rotSpeed;
			s.pulsePhase += s.pulseSpeed;
			if (s.visible) {
				s.hideIn--;
				if (s.hideIn <= 0) { s.visible = false; s.showIn = 12 + Math.floor(Math.random() * 25); }
			} else {
				s.showIn--;
				if (s.showIn <= 0) { s.visible = true;  s.hideIn = 100 + Math.floor(Math.random() * 220); }
			}
			if (!s.visible) continue;
			const pulse = 1.3 + 0.65 * Math.sin(s.pulsePhase);
			const r     = SUN_R * pulse;
			segs.push(cx, cy, cx + r * Math.cos(s.angle), cy + r * Math.sin(s.angle));
		}
		renderer!.lines(segs, GREEN, alpha);
		renderer!.points([cx, cy], WHITE, alpha, 5);
	}

	function drawStars(alpha: number) {
		const s = 2;
		const segs: number[] = [], pts: number[] = [];
		for (const [sx, sy] of stars) {
			segs.push(sx-s, sy-s, sx+s, sy+s,  sx+s, sy-s, sx-s, sy+s);
			pts.push(sx, sy);
		}
		renderer!.lines(segs, GREEN, alpha);
		renderer!.points(pts, WHITE, alpha, 2.5);
	}

	function drawShip(sx: number, sy: number, angle: number, thrusting: boolean, alpha: number) {
		const cos = Math.cos(angle), sin = Math.sin(angle);
		const local: [number, number][] = [[13, 0], [-7, -6], [-3, 0], [-7, 6]];
		const world = local.map(([x, y]) =>
			[sx + x*cos - y*sin, sy + x*sin + y*cos] as [number, number]
		);
		renderer!.strip(world.flat(), GREEN, alpha, true);
		renderer!.points(world.flat(), WHITE, alpha, 3);
		if (thrusting) {
			const exLocal: [number, number][] = [[-11, -5], [-17, 0], [-11, 5]];
			const exWorld = exLocal.map(([x, y]) =>
				[sx + x*cos - y*sin, sy + x*sin + y*cos] as [number, number]
			);
			renderer!.strip(exWorld.flat(), GREEN, alpha * (0.7 + Math.random() * 0.3));
		}
	}

	function drawExplosion(x: number, y: number, age: number, alpha: number) {
		const t    = Math.min(age / EXPLODE_FRAMES, 1);
		const fade = Math.max(0, 1 - t);
		const expand = 1 + t * 4;
		for (let i = 0; i < 14 + Math.floor(Math.random() * 8); i++) {
			const a  = Math.random() * TAU;
			const r1 = Math.random() * 4 * expand;
			const r2 = (4 + Math.random() * 18) * expand;
			renderer!.lines(
				[x + r1*Math.cos(a), y + r1*Math.sin(a), x + r2*Math.cos(a), y + r2*Math.sin(a)],
				RED, alpha * fade * (0.6 + Math.random() * 0.4)
			);
		}
		renderer!.points([x, y], WHITE, alpha * fade, 4);
	}

	// ── HUD ───────────────────────────────────────────────────────────────────────

	function drawHud(W: number, H: number, cx: number, cy: number, alpha: number, conic: Conic | null) {
		if (!renderer) return;

		// Scale font so the longest header line is 90% of viewport width.
		const fontSize = Math.max(8, Math.floor(W * 0.9 * CELL_H / (LONGEST_LINE.length * CELL_W)));
		resetBtnSize = fontSize;
		const lineH   = Math.round(fontSize * 1.4);
		const marginB = Math.round(lineH * 0.6);
		resetBtnMarginB = marginB;

		const txt = (t: string, x: number, y: number, color: RGB, size = fontSize, align: 'left'|'center'|'right' = 'left') => {
			renderer!.lines(textLines(t, x, y, size, align), color, alpha);
			const vtx: RGB = [Math.min(1, color[0] * 1.2 + 0.2), Math.min(1, color[1] * 1.2 + 0.2), Math.min(1, color[2] * 1.2 + 0.2)];
			renderer!.points(textPoints(t, x, y, size, align), vtx, alpha, 2.5);
		};

		// Header
		txt(FIRST_LINE, cx, lineH,     GREEN, fontSize, 'center');
		txt(LONGEST_LINE,               cx, lineH * 2, GREEN, fontSize, 'center');

		// Controls (bottom-left)
		txt('< > ROTATE   ^ THRUST', 12, H - marginB - lineH, GREEN);

		// Fuel
		txt(`FUEL: ${dvSpent.toFixed(1)}`, 12, H - marginB, GREEN);

		// Arrow geometry for velocity/heading indicators — right border aligned to right end of controls text.
		const half     = Math.round(fontSize * 0.6);
		const headBack = Math.round(half * 0.55);
		const hw       = Math.round(half * 0.35);
		const arrowX   = 12 + measureText('< > ROTATE   ^ THRUST', fontSize) - half;
		const velY     = H - marginB - fontSize * 0.5;
		arrowParams = { x: arrowX, y: velY, half, headBack, hw };

		// Danger / explosion message
		if (conic?.danger || exploded) {
			const msg = conic?.escaped ? 'ESCAPE VELOCITY ACHIEVED' : 'COLLISION IMMINENT';
			const dfs = Math.round(fontSize * 1.3);
			const dlineH = dfs * 1.4;
			const msgY = cy - initOrbitR - 30;
			txt(msg, cx, msgY, RED, dfs, 'center');
			let lineY = msgY;
			if (dangerDv != null) {
				lineY += dlineH;
				txt(`FUEL: ${dangerDv.toFixed(1)}`, cx, lineY, RED, dfs, 'center');
			}
			if (bestEscape !== null || bestCollision !== null) {
				lineY += dlineH * 1.3;
				txt('YOUR TOP SCORES', cx, lineY, RED, dfs, 'center');
				if (bestEscape !== null) {
					lineY += dlineH;
					txt(`ESCAPE:    ${bestEscape.toFixed(1)}`, cx, lineY, RED, dfs, 'center');
				}
				if (bestCollision !== null) {
					lineY += dlineH;
					txt(`COLLISION: ${bestCollision.toFixed(1)}`, cx, lineY, RED, dfs, 'center');
				}
			}
		}

		// Reset button (bottom-right)
		resetBtnW = measureText('[ RESET ]', fontSize);
		txt('[ RESET ]', W - 12, H - marginB, GREEN, fontSize, 'right');
	}

	// reset button hit zone
	function isResetZone(x: number, y: number, W: number, H: number): boolean {
		const dpr = window.devicePixelRatio || 1;
		const pad = 6;
		return x > W - 12 - resetBtnW / dpr - pad && y > H - (resetBtnSize + resetBtnMarginB) / dpr - pad;
	}

	function drawTouchZones(W: number, H: number) {
		const a = 0.09;
		if (keys.has('ArrowLeft'))  renderer!.fillRect(0,          0,      W * ZX,        H,      GREEN, a);
		if (keys.has('ArrowRight')) renderer!.fillRect(W*(1 - ZX), 0,      W,             H,      GREEN, a);
		if (keys.has('ArrowUp'))    renderer!.fillRect(W * ZX,     H * ZY, W * (1 - ZX), H,      GREEN, a);
	}

	// ── game loop ─────────────────────────────────────────────────────────────────
	function loop() {
		if (!glCanvas || !renderer) return;
		const W = glCanvas.width, H = glCanvas.height;
		const cx = W / 2, cy = H / 2;
		const dt = 1 / 60;

		if (!exploded) {
			if (keys.has('ArrowLeft'))  shipAngle -= ROT;
			if (keys.has('ArrowRight')) shipAngle += ROT;
		}
		const thrusting = !exploded && keys.has('ArrowUp');

		// thrust sound
		if (thrusting !== wasThrusting) {
			if (thrusting) startThrustSound(); else stopThrustSound();
			wasThrusting = thrusting;
		}

		if (!exploded) {
			integrateGravity(dt);
			if (thrusting) {
				vx += Math.cos(shipAngle) * THRUST * dt;
				vy += Math.sin(shipAngle) * THRUST * dt;
				dvSpent += THRUST * dt;
			}
			if (Math.hypot(px, py) < SUN_R) {
				exploded  = true;
				explodeX  = cx + px;
				explodeY  = cy + py;
				explodeAge = 0;
				stopThrustSound();
				wasThrusting = false;
			}
		} else {
			explodeAge++;
		}

		const conic      = computeConic();
		const isDanger   = !exploded && (conic?.danger ?? false);
		if (isDanger && !prevDanger) {
			dangerDv = dvSpent;
			if (!(conic?.escaped) && (bestCollision === null || dvSpent < bestCollision)) {
				bestCollision = dvSpent;
				localStorage.setItem('ev_best_collision', dvSpent.toString());
			}
		}
		if (!isDanger && !exploded)  dangerDv = null;
		prevDanger = isDanger;
		const isEscaped  = conic?.escaped ?? false;
		if (isEscaped && !prevEscaped) {
			if (bestEscape === null || dvSpent < bestEscape) {
				bestEscape = dvSpent;
				localStorage.setItem('ev_best_escape', dvSpent.toString());
			}
		}
		prevEscaped = isEscaped;
		const orbitColor: RGB = conic?.danger ? RED : GREEN;
		const alpha      = 0.8 + Math.random() * 0.2;

		renderer.beginFrame();
		drawStars(alpha);

		if (conic) {
			const pts = conicPoints(conic, cx, cy);
			if (pts.length >= 4) {
				renderer.strip(pts, orbitColor, alpha, conic.e < 1);
				renderer.points(pts, WHITE, alpha, 2.5);
			}
		}

		drawSun(cx, cy, alpha);

		if (exploded) drawExplosion(explodeX, explodeY, explodeAge, alpha);
		else          drawShip(cx + px, cy + py, shipAngle, thrusting, alpha);

		drawTouchZones(W, H);

		// HUD draws last so text is on top; also populates arrowParams.
		drawHud(W, H, cx, cy, alpha, conic);

		// draw arrows via bloom renderer
		if (arrowParams) {
			const { x: ax, y: ay, half: h, headBack: hb, hw: hw_ } = arrowParams;
			function arrowSegs(angle: number): number[] {
				const c = Math.cos(angle), s = Math.sin(angle);
				const tx = ax + c * h, ty = ay + s * h;
				const nx_ = -s, ny_ = c;
				return [
					ax - c*h, ay - s*h, tx, ty,
					tx, ty, tx - c*hb + nx_*hw_, ty - s*hb + ny_*hw_,
					tx, ty, tx - c*hb - nx_*hw_, ty - s*hb - ny_*hw_,
				];
			}
			const WHITE_DIM: RGB = [0.55, 0.55, 0.55];
			const speed = Math.hypot(vx, vy);
			if (speed > 0.001) renderer.lines(arrowSegs(Math.atan2(vy, vx)), WHITE_DIM, alpha);
			renderer.lines(arrowSegs(shipAngle), GREEN, alpha);
		}

		renderer.endFrame();

		rafId = requestAnimationFrame(loop);
	}

	// ── lifecycle ─────────────────────────────────────────────────────────────────
	$effect(() => {
		if (!glCanvas) return;

		renderer = new BloomRenderer(glCanvas);

		const savedEscape    = parseFloat(localStorage.getItem('ev_best_escape')    ?? '');
		const savedCollision = parseFloat(localStorage.getItem('ev_best_collision') ?? '');
		if (!isNaN(savedEscape))    bestEscape    = savedEscape;
		if (!isNaN(savedCollision)) bestCollision = savedCollision;

		const resize = () => {
			if (!glCanvas || !renderer) return;
			const dpr = window.devicePixelRatio || 1;
			const w = Math.round(glCanvas.offsetWidth * dpr);
			const h = Math.round(glCanvas.offsetHeight * dpr);
			glCanvas.width  = w; glCanvas.height  = h;
			renderer.resize(w, h);
			generateStars(w, h);
		};
		resize();
		window.addEventListener('resize', resize);
		reset();

		const onKeyDown = (e: KeyboardEvent) => {
			if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) e.preventDefault();
			if (e.key === 'r' || e.key === 'R') reset();
			keys.add(e.key);
		};
		const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup',   onKeyUp);

		const onTouchStart = (e: TouchEvent) => { e.preventDefault(); applyTouches(e.changedTouches, true); };
		const onTouchMove  = (e: TouchEvent) => { e.preventDefault(); applyTouches(e.changedTouches, true); };
		const onTouchEnd   = (e: TouchEvent) => {
			e.preventDefault();
			const rect = glCanvas!.getBoundingClientRect();
			for (let i = 0; i < e.changedTouches.length; i++) {
				const t = e.changedTouches[i];
				if (isResetZone(t.clientX - rect.left, t.clientY - rect.top, rect.width, rect.height)) {
					reset();
					break;
				}
			}
			applyTouches(e.changedTouches, false);
		};
		const onClick = (e: MouseEvent) => {
			const rect = glCanvas!.getBoundingClientRect();
			if (isResetZone(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)) reset();
		};
		glCanvas.addEventListener('click', onClick);
		glCanvas.addEventListener('touchstart',  onTouchStart, { passive: false });
		glCanvas.addEventListener('touchmove',   onTouchMove,  { passive: false });
		glCanvas.addEventListener('touchend',    onTouchEnd,   { passive: false });
		glCanvas.addEventListener('touchcancel', onTouchEnd,   { passive: false });

		rafId = requestAnimationFrame(loop);

		return () => {
			cancelAnimationFrame(rafId);
			stopThrustSound();
			window.removeEventListener('resize',  resize);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup',   onKeyUp);
			glCanvas?.removeEventListener('click', onClick);
			glCanvas?.removeEventListener('touchstart',  onTouchStart);
			glCanvas?.removeEventListener('touchmove',   onTouchMove);
			glCanvas?.removeEventListener('touchend',    onTouchEnd);
			glCanvas?.removeEventListener('touchcancel', onTouchEnd);
			renderer?.destroy();
			renderer = null;
		};
	});
</script>

<svelte:head>
	<title>Surly Bonds</title>
</svelte:head>

<div class="screen">
	<canvas class="layer" bind:this={glCanvas}></canvas>
</div>

<style>
	:global(body) {
		margin: 0;
		overflow: hidden;
		background: #000;
	}

	.screen {
		position: relative;
		width: 100vw;
		height: 100vh;
		background: #000;
	}

	.layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		touch-action: none;
		cursor: default;
	}
</style>
