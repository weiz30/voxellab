/**
 * TerrainGenerator — generates mountain-range voxel terrain using
 * multi-octave value noise (FBM) with elevation-based vertex coloring.
 *
 * Pure functions only — no Three.js dependency, no side effects.
 * Can be imported and tested from Node.js or the browser independently.
 */

// --- World style palettes ---

/**
 * Available world styles. The seed + style fully determine the world, so the
 * same combination always reproduces the same terrain.
 */
export const TERRAIN_STYLES = ['green', 'forest', 'desert', 'snow', 'ocean', 'volcano', 'candy', 'cave', 'skyisland'];

/**
 * Palette function per style. Receives `ratio` in [0,1] (elevation / maxHeight)
 * and returns [r, g, b] in [0,1].
 * @param {string} style
 * @param {number} ratio
 * @returns {[number, number, number]}
 */
function _styleColor(style, ratio) {
  const t = Math.max(0, Math.min(1, ratio));

  switch (style) {
    case 'desert': {
      // Sand dunes → red rock
      if (t < 0.3) return lerpColor([0.82, 0.72, 0.42], [0.93, 0.82, 0.55], t / 0.3);
      if (t < 0.65) return lerpColor([0.93, 0.82, 0.55], [0.62, 0.38, 0.22], (t - 0.3) / 0.35);
      return lerpColor([0.62, 0.38, 0.22], [0.45, 0.25, 0.15], (t - 0.65) / 0.35);
    }
    case 'snow': {
      // Pale ice → blue-grey rock → pure white peaks
      if (t < 0.35) return lerpColor([0.55, 0.68, 0.80], [0.70, 0.80, 0.90], t / 0.35);
      if (t < 0.7) return lerpColor([0.70, 0.80, 0.90], [0.85, 0.88, 0.92], (t - 0.35) / 0.35);
      return lerpColor([0.85, 0.88, 0.92], [1.00, 1.00, 1.00], (t - 0.7) / 0.3);
    }
    case 'ocean': {
      // Deep sea → aqua → pale sand (shallow shores)
      if (t < 0.35) return lerpColor([0.05, 0.25, 0.45], [0.10, 0.45, 0.55], t / 0.35);
      if (t < 0.7) return lerpColor([0.10, 0.45, 0.55], [0.25, 0.70, 0.65], (t - 0.35) / 0.35);
      return lerpColor([0.25, 0.70, 0.65], [0.86, 0.82, 0.62], (t - 0.7) / 0.3);
    }
    case 'volcano': {
      // Charred rock → red/orange lava bands
      if (t < 0.3) return lerpColor([0.15, 0.12, 0.12], [0.30, 0.20, 0.18], t / 0.3);
      if (t < 0.55) return lerpColor([0.30, 0.20, 0.18], [0.70, 0.30, 0.12], (t - 0.3) / 0.25);
      if (t < 0.75) return lerpColor([0.70, 0.30, 0.12], [1.00, 0.55, 0.10], (t - 0.55) / 0.2);
      return lerpColor([1.00, 0.55, 0.10], [0.95, 0.85, 0.30], (t - 0.75) / 0.25);
    }
    case 'candy': {
      // Rainbow bands cycling through hue
      const bands = [
        [0.95, 0.35, 0.40], // red-pink
        [0.95, 0.60, 0.25], // orange
        [0.90, 0.80, 0.30], // yellow
        [0.35, 0.75, 0.40], // green
        [0.35, 0.65, 0.90], // blue
        [0.65, 0.45, 0.85], // purple
      ];
      const idx = Math.min(bands.length - 1, Math.floor(t * bands.length));
      const next = Math.min(bands.length - 1, idx + 1);
      const f = t * bands.length - idx;
      return lerpColor(bands[idx], bands[next], f);
    }
    case 'forest': {
      // Dense lush greens: dark undergrowth → bright canopy
      if (t < 0.25) return lerpColor([0.18, 0.30, 0.12], [0.15, 0.45, 0.18], t / 0.25);
      if (t < 0.6) return lerpColor([0.15, 0.45, 0.18], [0.25, 0.62, 0.24], (t - 0.25) / 0.35);
      if (t < 0.85) return lerpColor([0.25, 0.62, 0.24], [0.35, 0.70, 0.30], (t - 0.6) / 0.25);
      return lerpColor([0.35, 0.70, 0.30], [0.30, 0.60, 0.28], (t - 0.85) / 0.15);
    }
    case 'cave': {
      // Dark cave stone with subtle mineral tints
      if (t < 0.4) return lerpColor([0.16, 0.14, 0.16], [0.26, 0.22, 0.26], t / 0.4);
      if (t < 0.75) return lerpColor([0.26, 0.22, 0.26], [0.42, 0.34, 0.38], (t - 0.4) / 0.35);
      return lerpColor([0.42, 0.34, 0.38], [0.55, 0.48, 0.50], (t - 0.75) / 0.25);
    }
    case 'skyisland': {
      // Floating islands: grassy tops, dirt undersides
      if (t < 0.45) return lerpColor([0.45, 0.30, 0.18], [0.38, 0.50, 0.24], t / 0.45);
      if (t < 0.75) return lerpColor([0.38, 0.50, 0.24], [0.45, 0.72, 0.32], (t - 0.45) / 0.3);
      return lerpColor([0.45, 0.72, 0.32], [0.35, 0.60, 0.26], (t - 0.75) / 0.25);
    }
    case 'green':
    default: {
      // Grass → rock → snow (the original look)
      if (t < 0.2) return lerpColor([0.25, 0.15, 0.10], [0.50, 0.40, 0.15], t / 0.2);
      if (t < 0.55) return lerpColor([0.50, 0.40, 0.15], [0.30, 0.65, 0.05], (t - 0.2) / 0.35);
      if (t < 0.75) return lerpColor([0.30, 0.65, 0.05], [0.60, 0.30, 0.10], (t - 0.55) / 0.2);
      if (t < 0.9) return lerpColor([0.60, 0.30, 0.10], [0.80, 0.50, 0.25], (t - 0.75) / 0.15);
      return lerpColor([0.80, 0.50, 0.25], [1.00, 1.00, 1.00], (t - 0.9) / 0.1);
    }
  }
}

/**
 * Linear interpolation between two [r,g,b] colors.
 * @param {[number,number,number]} a
 * @param {[number,number,number]} b
 * @param {number} t
 * @returns {[number,number,number]}
 */
function lerpColor(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// --- Permutation table for value noise ---

/**
 * Create a shuffled permutation table (size 512, repeats twice for
 * seamless wrapping). Uses a simple LCG seeded from `seed` so the
 * same seed produces the same terrain every time.
 * @param {number} seed
 * @returns {Uint8Array}
 */
function _makePermTable(seed) {
  // Build array 0..255
  const arr = new Uint8Array(256);
  for (let i = 0; i < 256; i++) arr[i] = i;

  // Fisher-Yates shuffle seeded by a simple LCG
  let s = seed | 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) >>> 24; // high byte
  };

  for (let i = 255; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }

  // Double up to 512 for simpler wrapping
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = arr[i & 255];
  return perm;
}

/**
 * 2D value noise at (x, z) using the permutation table.
 * Returns a value in [0, 1].
 * @param {number} x
 * @param {number} z
 * @param {Uint8Array} perm
 * @returns {number}
 */
function _noise2D(x, z, perm) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;

  // Smoothstep interpolation
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);

  const ixi = ix & 255;
  const izi = iz & 255;

  const v00 = perm[perm[ixi] + izi] / 255;
  const v10 = perm[perm[ixi + 1] + izi] / 255;
  const v01 = perm[perm[ixi] + izi + 1] / 255;
  const v11 = perm[perm[ixi + 1] + izi + 1] / 255;

  const lerpX0 = v00 + (v10 - v00) * sx;
  const lerpX1 = v01 + (v11 - v01) * sx;
  return lerpX0 + (lerpX1 - lerpX0) * sz;
}

// --- Public API ---

/**
 * Generate a 2D heightmap using fractal Brownian motion (FBM)
 * over multi-octave value noise.
 *
 * @param {object} options
 * @param {number} options.size - The terrain spans from -size/2 to +size/2 on both X and Z (default 100)
 * @param {number} options.heightScale - Maximum possible height in blocks (default 20)
 * @param {number} options.seed - RNG seed for reproducibility (default 42)
 * @param {number} options.octaves - Number of noise octaves (default 6)
 * @param {number} options.persistence - Amplitude multiplier per octave (default 0.5)
 * @param {number} options.lacunarity - Frequency multiplier per octave (default 2.0)
 * @param {number} options.frequency - Base frequency (default 0.03)
 * @returns {{ heights: Float32Array, size: number, maxHeight: number }}
 *   heights is a 1D array indexed by [z * size + x] (row-major),
 *   where each value is the terrain height in blocks (>= 0).
 *   size is the total grid dimension.
 *   maxHeight is the maximum height value found.
 */
export function generateHeightmap(options = {}) {
  const {
    size = 100,
    heightScale = 20,
    seed = 42,
    octaves = 6,
    persistence = 0.5,
    lacunarity = 2.0,
    frequency = 0.03,
  } = options;

  const perm = _makePermTable(seed);
  const heights = new Float32Array(size * size);
  const half = size / 2;
  let maxHeight = 0;

  for (let z = 0; z < size; z++) {
    const wz = z - half;
    for (let x = 0; x < size; x++) {
      const wx = x - half;
      let amplitude = 1;
      let freq = frequency;
      let value = 0;
      let maxAmplitude = 0;

      for (let o = 0; o < octaves; o++) {
        const n = _noise2D(wx * freq, wz * freq, perm);
        value += n * amplitude;
        maxAmplitude += amplitude;
        amplitude *= persistence;
        freq *= lacunarity;
      }

      // Normalise to [0, 1] then scale
      const normalised = value / maxAmplitude;
      const h = Math.round(normalised * heightScale);
      heights[z * size + x] = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  return { heights, size, maxHeight };
}

/**
 * Get the terrain height (in blocks) at a given world coordinate.
 * Useful for placing the character on the surface.
 *
 * @param {number} wx - world X coordinate
 * @param {number} wz - world Z coordinate
 * @param {Float32Array} heights - heightmap array
 * @param {number} size - grid dimension
 * @returns {number} terrain height (integer number of blocks)
 */
export function getHeightAt(wx, wz, heights, size) {
  const half = size / 2;
  const x = Math.round(wx + half);
  const z = Math.round(wz + half);
  if (x < 0 || x >= size || z < 0 || z >= size) return 0;
  return heights[z * size + x];
}

/**
 * Determine a vertex colour based on elevation.
 *
 * @param {number} h - block Y coordinate (0 = base)
 * @param {number} maxHeight - maximum height in the terrain
 * @param {string} [style='green'] - world style palette
 * @returns {[number, number, number]} [r, g, b] in [0, 1] range
 */
export function getColorForHeight(h, maxHeight, style = 'green') {
  if (maxHeight <= 0) return _styleColor(style, 0.5);

  return _styleColor(style, h / maxHeight);
}

/**
 * Linear interpolation between two numbers.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 3D value noise at (x, y, z) using the permutation table.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Uint8Array} perm
 * @returns {number} value in [0, 1]
 */
function _noise3D(x, y, z, perm) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);

  const X = ix & 255;
  const Y = iy & 255;
  const Z = iz & 255;
  const v = (a, b, c) => perm[perm[perm[a & 255] + (b & 255)] + (c & 255)] / 255;

  const c000 = v(X, Y, Z), c100 = v(X + 1, Y, Z);
  const c010 = v(X, Y + 1, Z), c110 = v(X + 1, Y + 1, Z);
  const c001 = v(X, Y, Z + 1), c101 = v(X + 1, Y, Z + 1);
  const c011 = v(X, Y + 1, Z + 1), c111 = v(X + 1, Y + 1, Z + 1);

  const x00 = lerp(c000, c100, sx), x10 = lerp(c010, c110, sx);
  const x01 = lerp(c001, c101, sx), x11 = lerp(c011, c111, sx);
  const y0 = lerp(x00, x10, sy), y1 = lerp(x01, x11, sy);
  return lerp(y0, y1, sz);
}

/**
 * Fill a heightmap with cubes (columns from y=0 up to each height).
 * @param {{heights: Float32Array, size: number, maxHeight: number}} heightmap
 * @param {string} style
 * @returns {Array<[number,number,number,number,number,number]>}
 */
function _fillHeightmap(heightmap, style) {
  const { heights, size, maxHeight } = heightmap;
  const cubes = [];
  const half = size / 2;

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const h = heights[z * size + x];
      const wx = x - half;
      const wz = z - half;

      for (let y = 0; y <= h; y++) {
        const color = getColorForHeight(y, maxHeight, style);
        cubes.push([
          wx + 0.5, y + 0.5, wz + 0.5,
          Math.round(color[0] * 100) / 100,
          Math.round(color[1] * 100) / 100,
          Math.round(color[2] * 100) / 100,
        ]);
      }
    }
  }

  return cubes;
}

/**
 * Compute a spawn position above the terrain surface (prefers the centre).
 * @param {Array<[number,number,number,number,number,number]>} cubes
 * @returns {{x:number, y:number, z:number}}
 */
function _spawnFromCubes(cubes) {
  const near = cubes.filter((c) => Math.abs(c[0]) <= 1 && Math.abs(c[2]) <= 1);
  if (near.length > 0) {
    const top = Math.max(...near.map((c) => c[1]));
    return { x: 0, y: top + 1.5, z: 0 };
  }
  if (cubes.length > 0) {
    const tallest = cubes.reduce((a, b) => (b[1] > a[1] ? b : a), cubes[0]);
    return { x: tallest[0], y: tallest[1] + 2, z: tallest[2] };
  }
  return { x: 0, y: 6, z: 0 };
}

/**
 * Cave style: heightmap terrain carved by 3D value noise.
 * @returns {{cubes: Array, spawn: {x:number,y:number,z:number}}}
 */
function _generateCaveTerrain(options) {
  const {
    size = 100, heightScale = 20, seed = 42, octaves = 6,
    persistence = 0.5, lacunarity = 2.0, frequency = 0.03, style = 'cave',
  } = options;

  const heightmap = generateHeightmap({ size, heightScale, seed, octaves, persistence, lacunarity, frequency });
  const { heights, maxHeight } = heightmap;
  const perm = _makePermTable(seed);
  const cubes = [];
  const half = size / 2;

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const h = heights[z * size + x];
      const wx = x - half;
      const wz = z - half;

      for (let y = 0; y <= h; y++) {
        // Carve tunnels where the 3D noise is high.
        if (_noise3D(wx * 0.12, y * 0.12, wz * 0.12, perm) > 0.60) continue;

        const color = getColorForHeight(y, maxHeight, style);
        cubes.push([
          wx + 0.5, y + 0.5, wz + 0.5,
          Math.round(color[0] * 100) / 100,
          Math.round(color[1] * 100) / 100,
          Math.round(color[2] * 100) / 100,
        ]);
      }
    }
  }

  return { cubes, spawn: _spawnFromCubes(cubes) };
}

/**
 * Sky island style: several floating elliptical islands seeded deterministically.
 * @returns {{cubes: Array, spawn: {x:number,y:number,z:number}}}
 */
function _generateSkyIslands(options) {
  const {
    size = 100, heightScale = 20, seed = 42, style = 'skyisland',
  } = options;

  const half = size / 2;
  const cubes = [];

  let s = (seed * 2654435761) >>> 0;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const islands = [];
  const num = 5 + Math.floor(rng() * 3); // 5–7 islands
  for (let i = 0; i < num; i++) {
    islands.push({
      cx: i === 0 ? 0 : (rng() - 0.5) * size * 0.7,
      cz: i === 0 ? 0 : (rng() - 0.5) * size * 0.7,
      cy: 20 + rng() * 18,
      rx: 5 + rng() * 6,
      rz: 5 + rng() * 6,
      ry: 2.5 + rng() * 3,
    });
  }

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < size; z++) {
        const wx = x - half;
        const wy = y;
        const wz = z - half;

        for (const is of islands) {
          const dx = (wx - is.cx) / is.rx;
          const dy = (wy - is.cy) / is.ry;
          const dz = (wz - is.cz) / is.rz;
          if (dx * dx + dy * dy + dz * dz <= 1) {
            const ratio = (wy - (is.cy - is.ry)) / (2 * is.ry);
            const color = getColorForHeight(Math.max(0, ratio) * heightScale, heightScale, style);
            cubes.push([
              wx + 0.5, wy + 0.5, wz + 0.5,
              Math.round(color[0] * 100) / 100,
              Math.round(color[1] * 100) / 100,
              Math.round(color[2] * 100) / 100,
            ]);
            break;
          }
        }
      }
    }
  }

  return { cubes, spawn: _spawnFromCubes(cubes) };
}

/**
 * Generate an array of cube data entries suitable for saving to a scene file.
 * Each entry is [x, y, z, r, g, b].
 *
 * Dispatches to the right generator based on `style`:
 *   - 'cave' / 'skyisland' use dedicated structural generators
 *   - everything else uses the standard heightmap + palette
 *
 * @param {object} options  (same as generateHeightmap options, plus `style`)
 * @returns {{ cubes: Array<[number,number,number,number,number,number]>,
 *             heightmap: object,
 *             spawn: {x:number, y:number, z:number} }}
 */
export function generateTerrainCubes(options = {}) {
  const { style = 'green' } = options;

  if (style === 'skyisland') {
    const res = _generateSkyIslands(options);
    return { cubes: res.cubes, heightmap: { size: options.size || 100, maxHeight: 30 }, spawn: res.spawn };
  }

  if (style === 'cave') {
    const res = _generateCaveTerrain(options);
    return {
      cubes: res.cubes,
      heightmap: { size: options.size || 100, maxHeight: options.heightScale || 20 },
      spawn: res.spawn,
    };
  }

  const heightmap = generateHeightmap(options);
  const cubes = _fillHeightmap(heightmap, style);
  return { cubes, heightmap, spawn: _spawnFromCubes(cubes) };
}

/**
 * Format cube data into a scene file JSON blob (same format as SceneArchive).
 *
 * @param {string} name - scene name
 * @param {Array<[number,number,number,number,number,number]>} cubes
 * @param {number} centerHeight - terrain height at the center (for character placement)
 * @returns {string} JSON string ready to write to a .scene file
 */
export function formatSceneJSON(name, cubes, centerHeight) {
  const now = new Date();
  const chinaOffset = 8 * 60;
  const chinaTime = new Date(now.getTime() + chinaOffset * 60 * 1000);
  const savedAt = chinaTime.toISOString().replace(/\.\d{3}Z/, '+08:00');

  return JSON.stringify({
    version: 1,
    savedAt,
    numCubes: cubes.length,
    player: {
      posX: 0,
      posY: centerHeight,
      posZ: 0,
      rotationX: 0,
      rotationY: 0,
      rotationZ: 0,
    },
    cubes,
  }, null, 2);
}