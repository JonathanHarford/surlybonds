// Minimal WebGL2 renderer with GPU bloom: draw sharp neon-line geometry into an
// offscreen scene texture, then run a 2-tier progressive-downsample blur and
// composite (sharp core + blurred glow) to the canvas. Replaces per-shape
// ctx.shadowBlur, which is CPU-bound and scales with element count; this
// pipeline's cost is fixed regardless of how much geometry is drawn.

// ── Bloom tuning ──────────────────────────────────────────────────────────────

/** Blur kernel spread (texel scale) per downsampling tier.
 *  Larger = wider glow at that tier; values above ~2.0 produce banding. */
const BLUR_SPREAD_T1 = 1.0;  // half-res   — tight inner glow (~3–7 screen px)
const BLUR_SPREAD_T2 = 1.2;  // quarter-res — mid halo (~8–20 screen px)
const BLUR_SPREAD_T3 = 1.5;  // eighth-res  — soft outer depth

/** Composite mix: how much each blur tier adds to the sharp scene.
 *  Increase T1 for a brighter/tighter core glow; increase T2/T3 for wider halos. */
const BLOOM_W_T1 = 3.2;
const BLOOM_W_T2 = 1.2;
const BLOOM_W_T3 = 0.12;

// ─────────────────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

interface FBO {
	fbo: WebGLFramebuffer;
	tex: WebGLTexture;
	w: number;
	h: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
	const sh = gl.createShader(type)!;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		const info = gl.getShaderInfoLog(sh);
		gl.deleteShader(sh);
		throw new Error(`Shader compile error: ${info}`);
	}
	return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
	const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
	const prog = gl.createProgram()!;
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		const info = gl.getProgramInfoLog(prog);
		throw new Error(`Program link error: ${info}`);
	}
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	return prog;
}

function createFBO(gl: WebGL2RenderingContext, w: number, h: number): FBO {
	const tex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	const fbo = gl.createFramebuffer()!;
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return { fbo, tex, w, h };
}

function deleteFBO(gl: WebGL2RenderingContext, f: FBO) {
	gl.deleteFramebuffer(f.fbo);
	gl.deleteTexture(f.tex);
}

// ── shaders ──────────────────────────────────────────────────────────────────

const LINE_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
uniform vec2 uResolution;
out vec4 vColor;
void main() {
	vec2 clip = (aPos / uResolution) * 2.0 - 1.0;
	gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
	vColor = aColor;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

const POINT_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
layout(location=2) in float aSize;
uniform vec2 uResolution;
out vec4 vColor;
void main() {
	vec2 clip = (aPos / uResolution) * 2.0 - 1.0;
	gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
	gl_PointSize = aSize;
	vColor = aColor;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() {
	vec2 d = gl_PointCoord - vec2(0.5);
	float dist = length(d) * 2.0;
	float alpha = 1.0 - smoothstep(0.7, 1.0, dist);
	if (alpha <= 0.0) discard;
	fragColor = vec4(vColor.rgb, vColor.a * alpha);
}`;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = aPos * 0.5 + 0.5;
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Canvas blit — samples with Y-flipped UVs because canvas y=0 is top but GL v=0 is bottom.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
	fragColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y));
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 fragColor;
void main() {
	vec4 sum = texture(uTex, vUv) * 0.227027;
	sum += texture(uTex, vUv + uTexel * 1.384615) * 0.316216;
	sum += texture(uTex, vUv - uTexel * 1.384615) * 0.316216;
	sum += texture(uTex, vUv + uTexel * 3.230769) * 0.070270;
	sum += texture(uTex, vUv - uTexel * 3.230769) * 0.070270;
	fragColor = sum;
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uTier1;
uniform sampler2D uTier2;
uniform sampler2D uTier3;
out vec4 fragColor;
void main() {
	vec3 scene = texture(uScene, vUv).rgb;
	vec3 t1 = texture(uTier1, vUv).rgb;
	vec3 t2 = texture(uTier2, vUv).rgb;
	vec3 t3 = texture(uTier3, vUv).rgb;
	vec3 glow = t1 * ${BLOOM_W_T1} + t2 * ${BLOOM_W_T2} + t3 * ${BLOOM_W_T3};
	fragColor = vec4(scene + glow, 1.0);
}`;

export class BloomRenderer {
	private gl: WebGL2RenderingContext;
	private width = 0;
	private height = 0;

	private lineProgram: WebGLProgram;
	private pointProgram: WebGLProgram;
	private blurProgram: WebGLProgram;
	private compositeProgram: WebGLProgram;
	private blitProgram: WebGLProgram;
	private hudTex: WebGLTexture;

	private dynamicVBO: WebGLBuffer;
	private quadVBO: WebGLBuffer;

	private sceneFBO!: FBO;
	private tier1A!: FBO;
	private tier1B!: FBO;
	private tier2A!: FBO;
	private tier2B!: FBO;
	private tier3A!: FBO;
	private tier3B!: FBO;

	constructor(canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
		if (!gl) throw new Error('WebGL2 not supported');
		this.gl = gl;

		this.lineProgram = linkProgram(gl, LINE_VS, LINE_FS);
		this.pointProgram = linkProgram(gl, POINT_VS, POINT_FS);
		this.blurProgram = linkProgram(gl, QUAD_VS, BLUR_FS);
		this.compositeProgram = linkProgram(gl, QUAD_VS, COMPOSITE_FS);
		this.blitProgram = linkProgram(gl, QUAD_VS, BLIT_FS);
		this.hudTex = gl.createTexture()!;

		this.dynamicVBO = gl.createBuffer()!;
		this.quadVBO = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 3, -1, -1, 3]),
			gl.STATIC_DRAW
		);
	}

	resize(width: number, height: number) {
		const gl = this.gl;
		this.width = Math.max(1, width);
		this.height = Math.max(1, height);
		const halfW = Math.max(1, Math.floor(width / 2));
		const halfH = Math.max(1, Math.floor(height / 2));
		const quarterW = Math.max(1, Math.floor(width / 4));
		const quarterH = Math.max(1, Math.floor(height / 4));
		const eighthW = Math.max(1, Math.floor(width / 8));
		const eighthH = Math.max(1, Math.floor(height / 8));

		for (const f of [
			this.sceneFBO,
			this.tier1A, this.tier1B,
			this.tier2A, this.tier2B,
			this.tier3A, this.tier3B
		]) {
			if (f) deleteFBO(gl, f);
		}
		this.sceneFBO = createFBO(gl, this.width, this.height);
		this.tier1A = createFBO(gl, halfW, halfH);
		this.tier1B = createFBO(gl, halfW, halfH);
		this.tier2A = createFBO(gl, quarterW, quarterH);
		this.tier2B = createFBO(gl, quarterW, quarterH);
		this.tier3A = createFBO(gl, eighthW, eighthH);
		this.tier3B = createFBO(gl, eighthW, eighthH);
	}

	beginFrame() {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fbo);
		gl.viewport(0, 0, this.width, this.height);
		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive — overlapping lines accumulate brightness
	}

	private uploadLineData(points: number[], color: RGB, alpha: number): number {
		const gl = this.gl;
		const n = points.length / 2;
		const data = new Float32Array(n * 6);
		for (let i = 0; i < n; i++) {
			data[i * 6 + 0] = points[i * 2 + 0];
			data[i * 6 + 1] = points[i * 2 + 1];
			data[i * 6 + 2] = color[0];
			data[i * 6 + 3] = color[1];
			data[i * 6 + 4] = color[2];
			data[i * 6 + 5] = alpha;
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicVBO);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
		gl.useProgram(this.lineProgram);
		const stride = 6 * 4;
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4);
		gl.uniform2f(gl.getUniformLocation(this.lineProgram, 'uResolution'), this.width, this.height);
		return n;
	}

	/** Independent segments: [x0,y0,x1,y1, x2,y2,x3,y3, ...] drawn as gl.LINES. */
	lines(points: number[], color: RGB, alpha: number) {
		if (points.length < 4) return;
		const n = this.uploadLineData(points, color, alpha);
		this.gl.drawArrays(this.gl.LINES, 0, n - (n % 2));
	}

	/** Connected polyline: [x0,y0, x1,y1, ...] drawn as gl.LINE_STRIP (or LINE_LOOP if closed). */
	strip(points: number[], color: RGB, alpha: number, closed = false) {
		if (points.length < 4) return;
		const n = this.uploadLineData(points, color, alpha);
		this.gl.drawArrays(closed ? this.gl.LINE_LOOP : this.gl.LINE_STRIP, 0, n);
	}

	/** Filled axis-aligned rectangle. */
	fillRect(x0: number, y0: number, x1: number, y1: number, color: RGB, alpha: number) {
		const gl = this.gl;
		const [r, g, b] = color;
		const data = new Float32Array([
			x0, y0, r, g, b, alpha,
			x1, y0, r, g, b, alpha,
			x0, y1, r, g, b, alpha,
			x1, y1, r, g, b, alpha,
		]);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicVBO);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
		gl.useProgram(this.lineProgram);
		const stride = 6 * 4;
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4);
		gl.uniform2f(gl.getUniformLocation(this.lineProgram, 'uResolution'), this.width, this.height);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	/** Point sprites: [x0,y0, x1,y1, ...] drawn as small filled circles. */
	points(pts: number[], color: RGB, alpha: number, size = 4) {
		if (pts.length < 2) return;
		const gl = this.gl;
		const n = pts.length / 2;
		const data = new Float32Array(n * 7);
		for (let i = 0; i < n; i++) {
			data[i * 7 + 0] = pts[i * 2 + 0];
			data[i * 7 + 1] = pts[i * 2 + 1];
			data[i * 7 + 2] = color[0];
			data[i * 7 + 3] = color[1];
			data[i * 7 + 4] = color[2];
			data[i * 7 + 5] = alpha;
			data[i * 7 + 6] = size;
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamicVBO);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
		gl.useProgram(this.pointProgram);
		const stride = 7 * 4;
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 6 * 4);
		gl.uniform2f(gl.getUniformLocation(this.pointProgram, 'uResolution'), this.width, this.height);
		gl.drawArrays(gl.POINTS, 0, n);
	}

	private blurPass(src: FBO, dst: FBO, dir: [number, number], spread: number) {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
		gl.viewport(0, 0, dst.w, dst.h);
		gl.disable(gl.BLEND);
		gl.useProgram(this.blurProgram);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, src.tex);
		gl.uniform1i(gl.getUniformLocation(this.blurProgram, 'uTex'), 0);
		// Texel size is scaled off the (smaller) destination resolution — sizing
		// it off the source would make the kernel width sub-pixel relative to
		// the downsampled image, producing an almost-imperceptible blur.
		gl.uniform2f(
			gl.getUniformLocation(this.blurProgram, 'uTexel'),
			(dir[0] * spread) / dst.w,
			(dir[1] * spread) / dst.h
		);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	/** Blit a 2D canvas into the scene FBO so its pixels get bloom applied. Call before endFrame(). */
	blitCanvas(canvas: HTMLCanvasElement) {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fbo);
		gl.viewport(0, 0, this.width, this.height);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

		// activeTexture must come BEFORE bindTexture so the texture lands on unit 0.
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.hudTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		gl.useProgram(this.blitProgram);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.uniform1i(gl.getUniformLocation(this.blitProgram, 'uTex'), 0);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	/** Runs the bloom blur chain and composites sharp + glow to the visible canvas. */
	endFrame() {
		const gl = this.gl;

		// Tier 1: half-res — tight inner glow (≈3–7 screen pixels).
		this.blurPass(this.sceneFBO, this.tier1A, [1, 0], BLUR_SPREAD_T1);
		this.blurPass(this.tier1A,   this.tier1B, [0, 1], BLUR_SPREAD_T1);

		// Tier 2: quarter-res — narrow halo (≈8–20 screen pixels).
		this.blurPass(this.tier1B,   this.tier2A, [1, 0], BLUR_SPREAD_T2);
		this.blurPass(this.tier2A,   this.tier2B, [0, 1], BLUR_SPREAD_T2);

		// Tier 3: eighth-res — barely visible; keeps a hair of soft depth.
		this.blurPass(this.tier2B,   this.tier3A, [1, 0], BLUR_SPREAD_T3);
		this.blurPass(this.tier3A,   this.tier3B, [0, 1], BLUR_SPREAD_T3);

		// Composite sharp core + all three glow tiers to the canvas.
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.width, this.height);
		gl.disable(gl.BLEND);
		gl.useProgram(this.compositeProgram);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.sceneFBO.tex);
		gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uScene'), 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.tier1B.tex);
		gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uTier1'), 1);
		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, this.tier2B.tex);
		gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uTier2'), 2);
		gl.activeTexture(gl.TEXTURE3);
		gl.bindTexture(gl.TEXTURE_2D, this.tier3B.tex);
		gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uTier3'), 3);

		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	destroy() {
		const gl = this.gl;
		for (const f of [
			this.sceneFBO,
			this.tier1A, this.tier1B,
			this.tier2A, this.tier2B,
			this.tier3A, this.tier3B
		]) {
			if (f) deleteFBO(gl, f);
		}
		gl.deleteBuffer(this.dynamicVBO);
		gl.deleteBuffer(this.quadVBO);
		gl.deleteTexture(this.hudTex);
		gl.deleteProgram(this.lineProgram);
		gl.deleteProgram(this.pointProgram);
		gl.deleteProgram(this.blurProgram);
		gl.deleteProgram(this.compositeProgram);
		gl.deleteProgram(this.blitProgram);
	}
}
