// All-caps vector stroke font for WebGL rendering.
// Letters and digits use only the 9 dots of a 3×3 grid:
//   x ∈ {0,2,4}  ×  y ∈ {0,4,8}  (baseline y=8, top y=0).
// Punctuation may use off-grid coordinates for legibility.
// Each glyph is an array of polylines; each polyline is a flat [x0,y0,x1,y1,...].

export const CELL_W = 6;
export const CELL_H = 8;

// Grid-point aliases for reference:
//   TL=(0,0) TC=(2,0) TR=(4,0)
//   ML=(0,4) MC=(2,4) MR=(4,4)
//   BL=(0,8) BC=(2,8) BR=(4,8)
const G: Record<string, number[][]> = {
	'A': [[0,8, 2,0, 4,8], [0,4, 4,4]],                                // tent + crossbar
	'B': [[0,0, 0,8],                                                   // left vert
	      [0,0, 4,0, 2,4, 0,4],                                   // top diamond bump
	      [0,4, 2,4, 4,4, 2,8, 0,8]],                                  // bottom diamond bump
	'C': [[4,0, 0,0, 0,8, 4,8]],                                       // open-right bracket
	'D': [[0,0, 0,8], [0,0, 2,0, 4,4, 2,8, 0,8]],                     // left vert + diamond arc
	'E': [[0,0, 0,8], [0,0, 4,0], [0,4, 2,4], [0,8, 4,8]],            // left vert + 3 bars
	'F': [[0,0, 0,8], [0,0, 4,0], [0,4, 2,4]],                        // E without bottom bar
	'G': [[4,0, 0,0, 0,8, 4,8, 4,4, 2,4]],                            // C + mid prong
	'H': [[0,0, 0,8], [4,0, 4,8], [0,4, 4,4]],                        // two verts + crossbar
	'I': [[0,0, 4,0], [2,0, 2,8], [0,8, 4,8]],                        // seriffed center vert
	'J': [[0,0, 4,0], [4,0, 4,8, 0,8]],                               // top bar + hook
	'K': [[0,0, 0,8], [4,0, 0,4], [0,4, 4,8]],                        // left vert + diagonals
	'L': [[0,0, 0,8, 4,8]],                                            // left vert + bottom bar
	'M': [[0,8, 0,0, 2,4, 4,0, 4,8]],                                  // two verts + V from top
	'N': [[0,8, 0,0, 4,8, 4,0]],                                       // two verts + diagonal
	'O': [[0,0, 4,0, 4,8, 0,8, 0,0]],                                  // rectangle
	'P': [[0,8, 0,0, 4,0, 4,4, 0,4]],                                  // left vert + top bump
	'Q': [[0,0, 4,0, 4,8, 0,8, 0,0], [2,4, 4,8]],                     // O + diagonal tail
	'R': [[0,0, 0,8], [0,0, 4,0, 4,4, 0,4], [2,4, 4,8]],              // P + diagonal leg
	'S': [[4,0, 0,0, 0,4, 4,4, 4,8, 0,8]],                            // six-point zigzag
	'T': [[0,0, 4,0], [2,0, 2,8]],                                     // top bar + center vert
	'U': [[0,0, 0,8, 4,8, 4,0]],                                       // open-top bracket
	'V': [[0,0, 2,8, 4,0]],                                            // two diagonals
	'W': [[0,0, 0,8, 2,4, 4,8, 4,0]],                                  // two verts + center peak
	'X': [[0,0, 4,8], [4,0, 0,8]],                                     // crossing diagonals
	'Y': [[0,0, 2,4, 4,0], [2,4, 2,8]],                               // upper V + stem
	'Z': [[0,0, 4,0, 0,8, 4,8]],                                       // top bar + diagonal + bottom bar
	'0': [[0,0, 4,0, 4,8, 0,8, 0,0], [0,8, 4,0]],                     // rectangle + slash
	'1': [[2,0, 2,8], [0,8, 4,8]],                                     // vert + base
	'2': [[0,0, 4,0, 4,4, 0,4, 0,8, 4,8]],                            // reverse-S shape
	'3': [[0,0, 4,0, 4,8, 0,8], [0,4, 4,4]],                          // right bracket + crossbar
	'4': [[0,0, 0,4, 4,4], [4,0, 4,8]],                               // left partial vert + arm + right vert
	'5': [[4,0, 0,0, 0,4, 4,4, 4,8, 0,8]],                            // same path as S (accepted)
	'6': [[4,0, 0,0, 0,8, 4,8, 4,4, 0,4]],                            // open top + closed bottom loop
	'7': [[0,0, 4,0, 4,8]],                                            // top bar + right vert
	'8': [[0,0, 4,0, 4,4, 0,4, 0,0], [0,4, 4,4, 4,8, 0,8, 0,4]],     // two rectangular loops
	'9': [[0,8, 4,8, 4,0, 0,0, 0,4, 4,4]],                            // closed top loop + open bottom
	' ': [],
	'.': [[1,7, 3,7, 3,8, 1,8, 1,7]],
	',': [[2,6, 2,7, 1,8]],
	':': [[2,2, 2,3], [2,5, 2,6]],
	'?': [[0,2, 0,0, 4,0, 4,4, 2,4, 2,6], [2,7, 2,8]],
	'!': [[2,0, 2,6], [2,7, 2,8]],
	'[': [[3,0, 1,0, 1,8, 3,8]],
	']': [[1,0, 3,0, 3,8, 1,8]],
	'<': [[4,1, 0,4, 4,7]],
	'>': [[0,1, 4,4, 0,7]],
	'^': [[0,3, 2,0, 4,3]],
	'-': [[0,4, 4,4]],
	'(': [[3,0, 1,2, 1,6, 3,8]],
	')': [[1,0, 3,2, 3,6, 1,8]],
	'/': [[4,0, 0,8]],
};

/** Unique stroke-junction positions — for drawing vertex dots over text. */
export function textPoints(
	text: string,
	x: number,
	y: number,
	fontSize: number,
	align: 'left' | 'center' | 'right' = 'left',
): number[] {
	const upper = text.toUpperCase();
	const scale = fontSize / CELL_H;
	const totalW = upper.length * CELL_W * scale;

	let left = x;
	if (align === 'center') left = x - totalW / 2;
	else if (align === 'right') left = x - totalW;

	const seen = new Set<string>();
	const out: number[] = [];

	for (let i = 0; i < upper.length; i++) {
		const ch = upper[i];
		const charX = left + i * CELL_W * scale;
		const strokes = G[ch] ?? [];
		for (const stroke of strokes) {
			for (let j = 0; j + 1 < stroke.length; j += 2) {
				const vx = charX + stroke[j] * scale;
				const vy = y + (stroke[j + 1] - CELL_H) * scale;
				const key = `${vx},${vy}`;
				if (!seen.has(key)) {
					seen.add(key);
					out.push(vx, vy);
				}
			}
		}
	}

	return out;
}

/** Pixel width of a string at the given font size (cap height in px). */
export function measureText(text: string, fontSize: number): number {
	return text.length * CELL_W * fontSize / CELL_H;
}

/**
 * Returns flat [x0,y0,x1,y1,...] segments suitable for renderer.lines().
 * x = left edge (adjusted for align), y = baseline in screen pixels (y increases down).
 * Text is rendered all-uppercase.
 */
export function textLines(
	text: string,
	x: number,
	y: number,
	fontSize: number,
	align: 'left' | 'center' | 'right' = 'left',
): number[] {
	const upper = text.toUpperCase();
	const scale = fontSize / CELL_H;
	const totalW = upper.length * CELL_W * scale;

	let left = x;
	if (align === 'center') left = x - totalW / 2;
	else if (align === 'right') left = x - totalW;

	const out: number[] = [];

	for (let i = 0; i < upper.length; i++) {
		const ch = upper[i];
		const charX = left + i * CELL_W * scale;
		const strokes = G[ch] ?? [];

		for (const stroke of strokes) {
			for (let j = 0; j + 3 < stroke.length; j += 2) {
				out.push(
					charX + stroke[j]     * scale,
					y     + (stroke[j + 1] - CELL_H) * scale,
					charX + stroke[j + 2] * scale,
					y     + (stroke[j + 3] - CELL_H) * scale,
				);
			}
		}
	}

	return out;
}
