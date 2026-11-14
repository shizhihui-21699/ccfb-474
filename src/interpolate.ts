// ============ 插值: IDW 与普通克里金 ============
import { InterpParams, VariogramParams } from './types';

export interface Sample { x: number; y: number; z: number }

export interface GridSpec {
  x0: number; y0: number; x1: number; y1: number;
  nx: number; ny: number;
}

export class GridField {
  spec: GridSpec;
  values: Float32Array; // 行主序: j*nx + i
  constructor(spec: GridSpec) {
    this.spec = spec;
    this.values = new Float32Array(spec.nx * spec.ny).fill(NaN);
  }
  get dx() { return (this.spec.x1 - this.spec.x0) / (this.spec.nx - 1); }
  get dy() { return (this.spec.y1 - this.spec.y0) / (this.spec.ny - 1); }
  nodeX(i: number) { return this.spec.x0 + i * this.dx; }
  nodeY(j: number) { return this.spec.y0 + j * this.dy; }
  idx(i: number, j: number) { return j * this.spec.nx + i; }
  /** 双线性取值, 网格外夹到最近边缘 (Float32 坐标有舍入误差, 不宜判出界) */
  sample(x: number, y: number): number {
    const { nx, ny } = this.spec;
    const fx = Math.min(nx - 1, Math.max(0, (x - this.spec.x0) / this.dx));
    const fy = Math.min(ny - 1, Math.max(0, (y - this.spec.y0) / this.dy));
    const i0 = Math.min(nx - 2, Math.floor(fx)), j0 = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - i0, ty = fy - j0;
    const v00 = this.values[this.idx(i0, j0)], v10 = this.values[this.idx(i0 + 1, j0)];
    const v01 = this.values[this.idx(i0, j0 + 1)], v11 = this.values[this.idx(i0 + 1, j0 + 1)];
    if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) {
      // 退化: 取最近有效节点
      let best = NaN, bd = Infinity;
      for (const [ii, jj, v] of [[i0, j0, v00], [i0 + 1, j0, v10], [i0, j0 + 1, v01], [i0 + 1, j0 + 1, v11]] as const) {
        if (!Number.isNaN(v)) {
          const d = (ii - fx) ** 2 + (jj - fy) ** 2;
          if (d < bd) { bd = d; best = v; }
        }
      }
      return best;
    }
    return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  }
}

/** 变异函数 (半方差) */
export function semivariogram(h: number, v: VariogramParams): number {
  const r = Math.max(v.range, 1e-6);
  const c = Math.max(0, v.sill - v.nugget);
  switch (v.model) {
    case 'spherical': {
      if (h >= r) return v.sill;
      const t = h / r;
      return v.nugget + c * (1.5 * t - 0.5 * t * t * t);
    }
    case 'exponential':
      return v.nugget + c * (1 - Math.exp(-3 * h / r));
    case 'gaussian':
      return v.nugget + c * (1 - Math.exp(-3 * h * h / (r * r)));
  }
}

/** 协方差 C(h) = sill - γ(h) */
function covar(h: number, v: VariogramParams): number {
  return v.sill - semivariogram(h, v);
}

/** 高斯消元 (部分主元), 解 n×n 线性系统 A x = b, A 会被破坏 */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r * n + col]) > Math.abs(A[piv * n + col])) piv = r;
    }
    if (Math.abs(A[piv * n + col]) < 1e-12) return null;
    if (piv !== col) {
      for (let k = col; k < n; k++) {
        const t = A[col * n + k]; A[col * n + k] = A[piv * n + k]; A[piv * n + k] = t;
      }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / A[col * n + col];
      if (f === 0) continue;
      for (let k = col; k < n; k++) A[r * n + k] -= f * A[col * n + k];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** 收集 radius 内最近的 maxN 个样本 (暴力, 样本量 ≤ 数百时足够快) */
function neighbors(samples: Sample[], x: number, y: number, radius: number, maxN: number): { s: Sample; d: number }[] {
  const r2 = radius * radius;
  const cand: { s: Sample; d: number }[] = [];
  for (const s of samples) {
    const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d2 <= r2) cand.push({ s, d: Math.sqrt(d2) });
  }
  cand.sort((a, b) => a.d - b.d);
  return cand.slice(0, Math.max(3, maxN));
}

function idwAt(nb: { s: Sample; d: number }[], power: number): number {
  let wsum = 0, vsum = 0;
  for (const { s, d } of nb) {
    if (d < 1e-6) return s.z;
    const w = 1 / Math.pow(d, power);
    wsum += w; vsum += w * s.z;
  }
  return wsum > 0 ? vsum / wsum : NaN;
}

function krigingAt(nb: { s: Sample; d: number }[], x: number, y: number, v: VariogramParams): number {
  const k = nb.length;
  if (k < 3) return idwAt(nb, 2);
  const n = k + 1;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const d = Math.hypot(nb[i].s.x - nb[j].s.x, nb[i].s.y - nb[j].s.y);
      A[i * n + j] = covar(d, v);
    }
    A[i * n + k] = 1;
    A[k * n + i] = 1;
    b[i] = covar(nb[i].d, v);
  }
  b[k] = 1;
  const w = solve(A, b, n);
  if (!w) return idwAt(nb, 2);
  let z = 0;
  for (let i = 0; i < k; i++) z += w[i] * nb[i].s.z;
  return z;
}

/** 单点估值 */
export function estimateAt(samples: Sample[], x: number, y: number, p: InterpParams): number {
  if (samples.length === 0) return NaN;
  const nb = neighbors(samples, x, y, p.radius, p.maxNeighbors);
  if (nb.length === 0) {
    // 半径内无样本: 用全局最近点, 避免空洞
    let best = samples[0], bd = Infinity;
    for (const s of samples) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best.z;
  }
  if (p.method === 'kriging') return krigingAt(nb, x, y, p.variogram);
  return idwAt(nb, p.power);
}

/** 全场插值 */
export function interpolateGrid(samples: Sample[], grid: GridField, p: InterpParams): void {
  const { nx, ny } = grid.spec;
  for (let j = 0; j < ny; j++) {
    const y = grid.nodeY(j);
    for (let i = 0; i < nx; i++) {
      grid.values[grid.idx(i, j)] = estimateAt(samples, grid.nodeX(i), y, p);
    }
  }
}

/**
 * 局部重算: 只重算以 (cx,cy) 为圆心、radius 为半径的影响域内的网格节点。
 * 返回实际重算的节点数。
 */
export function recomputeRegion(
  samples: Sample[], grid: GridField, p: InterpParams,
  cx: number, cy: number, radius: number,
): number {
  const { nx, ny, x0, y0 } = grid.spec;
  const i0 = Math.max(0, Math.floor((cx - radius - x0) / grid.dx));
  const i1 = Math.min(nx - 1, Math.ceil((cx + radius - x0) / grid.dx));
  const j0 = Math.max(0, Math.floor((cy - radius - y0) / grid.dy));
  const j1 = Math.min(ny - 1, Math.ceil((cy + radius - y0) / grid.dy));
  if (i1 < i0 || j1 < j0) return 0;
  const r2 = radius * radius;
  let count = 0;
  for (let j = j0; j <= j1; j++) {
    const y = grid.nodeY(j);
    for (let i = i0; i <= i1; i++) {
      const x = grid.nodeX(i);
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      grid.values[grid.idx(i, j)] = estimateAt(samples, x, y, p);
      count++;
    }
  }
  return count;
}
