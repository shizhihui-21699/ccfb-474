// ============ 三维地层模型引擎 ============
// 层厚度法: 地表(DEM) + 各层厚度分别插值, 自上而下累加得到 n+1 个分界面;
// 厚度夹紧 >= 0, 为 0 处即尖灭, 从机制上杜绝界面交叉与幻影厚度;
// 正断层: 两盘分别插值, 下降盘各界面(除地表)整体减去断距 -> 两侧不连续;
// 改孔只在其影响半径内局部重算网格节点。
import { Collar, SurveyStation, LithoInterval, ModelParams } from './types';
import { computePath, pointAtMd, pointAtTvd, toWorld, PathPoint } from './trajectory';
import { GridField, Sample, interpolateGrid, recomputeRegion } from './interpolate';

export interface MeshData {
  name: string;
  color: string;
  positions: Float32Array;
  indices: Uint32Array;
}

interface Tess {
  xy: Float32Array;     // 每顶点 2 个数 (平面坐标)
  tris: Uint32Array;
  bndEdges: Uint32Array; // 边界边 (顶点索引对), 用于裙边
}

const D2R = Math.PI / 180;

export class GeoModel {
  params: ModelParams;
  collars = new Map<string, Collar>();
  surveys = new Map<string, SurveyStation[]>();
  lithos = new Map<string, LithoInterval[]>();

  paths = new Map<string, PathPoint[]>();
  extent = { x0: 0, y0: 0, x1: 1, y1: 1 };
  nB = 0; // 分界面数 = 地层数 + 1

  /** 地表样本 [block] = 孔号 -> 样本 */
  demSamples: Map<string, Sample>[] = [new Map(), new Map()];
  /** 厚度样本 [layer][block] = 孔号 -> 样本 (z 为真厚度) */
  thSamples: Map<string, Sample>[][] = [];
  /** 厚度网格 [layer][block] */
  thGrids: GridField[][] = [];
  /** 分界面高程网格 [bi][block], 由 DEM 与厚度派生 */
  grids: GridField[][] = [];
  tess: Tess[] = [];
  warnings: string[] = [];

  constructor(params: ModelParams) {
    this.params = params;
  }

  get nLayers() { return this.params.layerOrder.length; }

  // ---------- 断层 ----------
  faultDir(): { sx: number; sy: number } {
    const a = this.params.fault.strike * D2R;
    return { sx: Math.sin(a), sy: Math.cos(a) };
  }
  /** 点在断层哪一侧: 0 / 1 (无断层恒为 0) */
  faultSide(x: number, y: number): number {
    const f = this.params.fault;
    if (!f.enabled) return 0;
    const { sx, sy } = this.faultDir();
    const cross = sx * (y - f.y) - sy * (x - f.x);
    return cross >= 0 ? 0 : 1;
  }
  /** 下降盘 (倾向盘) 的 block 编号 */
  downthrownBlock(): number {
    // dip 方向 = strike+90°, 该侧 cross < 0 -> block 1
    return this.params.fault.enabled ? 1 : -1;
  }

  // ---------- 数据装载 ----------
  setData(collars: Collar[], surveys: SurveyStation[], lithos: LithoInterval[]) {
    this.collars = new Map(collars.map(c => [c.id, c]));
    this.surveys = new Map();
    for (const s of surveys) {
      if (!this.surveys.has(s.holeId)) this.surveys.set(s.holeId, []);
      this.surveys.get(s.holeId)!.push(s);
    }
    this.lithos = new Map();
    for (const l of lithos) {
      if (!this.lithos.has(l.holeId)) this.lithos.set(l.holeId, []);
      this.lithos.get(l.holeId)!.push(l);
    }
  }

  private computeExtent() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of this.collars.values()) {
      x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x);
      y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y);
    }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 100; y1 = 100; }
    const m = this.params.margin;
    if (x1 - x0 < 1) x1 = x0 + 1;
    if (y1 - y0 < 1) y1 = y0 + 1;
    this.extent = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  }

  /**
   * 单孔样本: 地表标高 + 各层真厚度。
   * 层缺失但更深处有层 -> 厚度 0 (真实尖灭); 孔未打到该层 -> 不贡献样本。
   */
  private holeSamples(id: string): { dem: Sample; th: (Sample | null)[]; path: PathPoint[] } | null {
    const c = this.collars.get(id);
    if (!c) return null;
    const path = computePath(c, this.surveys.get(id) ?? []);
    const n = this.nLayers;
    const intervals = (this.lithos.get(id) ?? [])
      .filter(l => this.params.layerOrder.includes(l.litho) && l.to > l.from)
      .sort((a, b) => a.from - b.from);
    const topOf: (number | null)[] = new Array(n).fill(null);
    const botOf: (number | null)[] = new Array(n).fill(null);
    for (const l of intervals) {
      const k = this.params.layerOrder.indexOf(l.litho);
      if (k < 0) continue;
      if (topOf[k] === null) topOf[k] = l.from;
      botOf[k] = botOf[k] === null ? l.to : Math.max(botOf[k]!, l.to);
    }
    const th: (Sample | null)[] = new Array(n).fill(null);
    for (let k = 0; k < n; k++) {
      const hasDeeper = botOf.slice(k + 1).some(b => b !== null);
      if (topOf[k] === null && !hasDeeper) continue; // 未打到, 不贡献
      const topMd = topOf[k] ?? (botOf[k - 1] ?? 0);
      const botMd = botOf[k] ?? topMd; // 缺失 -> 顶底重合, 厚度 0
      const pTop = pointAtMd(path, topMd);
      const pBot = pointAtMd(path, botMd);
      const tvdTop = pTop.tvd, tvdBot = pBot.tvd;
      const mid = pointAtTvd(path, (tvdTop + tvdBot) / 2);
      th[k] = {
        x: c.x + mid.dx,
        y: c.y + mid.dy,
        z: Math.max(0, tvdBot - tvdTop), // 真厚度
      };
    }
    return { dem: { x: c.x, y: c.y, z: c.z }, th, path };
  }

  private allocGrids() {
    const { gridNx, gridNy } = this.params;
    const e = this.extent;
    const spec = { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, nx: gridNx, ny: gridNy };
    this.nB = this.nLayers + 1;
    this.demSamples = [new Map(), new Map()];
    this.thSamples = [];
    this.thGrids = [];
    this.grids = [];
    for (let k = 0; k < this.nLayers; k++) {
      this.thSamples.push([new Map(), new Map()]);
      this.thGrids.push([new GridField(spec), new GridField(spec)]);
    }
    for (let bi = 0; bi < this.nB; bi++) {
      this.grids.push([new GridField(spec), new GridField(spec)]);
    }
  }

  /** 全量重建 */
  fullBuild() {
    this.warnings = [];
    this.computeExtent();
    this.allocGrids();
    this.paths.clear();
    for (const id of this.collars.keys()) {
      const hs = this.holeSamples(id);
      if (!hs) continue;
      this.paths.set(id, hs.path);
      const blk = this.faultSide(hs.dem.x, hs.dem.y);
      this.demSamples[blk].set(id, hs.dem);
      for (let k = 0; k < this.nLayers; k++) {
        const s = hs.th[k];
        if (s) this.thSamples[k][this.faultSide(s.x, s.y)].set(id, s);
      }
    }
    for (let blk = 0; blk < 2; blk++) {
      interpolateGrid(this.demArray(blk), this.grids[0][blk], this.params.interp);
      for (let k = 0; k < this.nLayers; k++) {
        interpolateGrid(this.thArray(k, blk), this.thGrids[k][blk], this.params.interp);
      }
    }
    this.deriveBoundaries();
    this.buildTess();
  }

  private demArray(blk: number): Sample[] {
    const own = [...this.demSamples[blk].values()];
    if (own.length >= 3) return own;
    const other = [...this.demSamples[1 - blk].values()];
    if (other.length > 0) {
      const msg = `地表 的 ${blk === 0 ? 'A' : 'B'} 盘样本不足(${own.length}), 借用对侧样本`;
      if (!this.warnings.includes(msg)) this.warnings.push(msg);
    }
    return own.concat(other);
  }
  private thArray(k: number, blk: number): Sample[] {
    const own = [...this.thSamples[k][blk].values()];
    if (own.length >= 3) return own;
    const other = [...this.thSamples[k][1 - blk].values()];
    if (other.length > 0) {
      const msg = `层 ${this.params.layerOrder[k]} 厚度 的 ${blk === 0 ? 'A' : 'B'} 盘样本不足(${own.length}), 借用对侧样本`;
      if (!this.warnings.includes(msg)) this.warnings.push(msg);
    }
    return own.concat(other);
  }

  /** 由 DEM + 厚度派生分界面, 并施加断层落差 */
  private deriveBoundaries() {
    for (let blk = 0; blk < 2; blk++) {
      // 厚度夹紧 >= 0 (克里金可能过冲为负 -> 尖灭)
      for (let k = 0; k < this.nLayers; k++) {
        const v = this.thGrids[k][blk].values;
        for (let i = 0; i < v.length; i++) if (!(v[i] >= 0)) v[i] = 0;
      }
      for (let k = 0; k < this.nLayers; k++) {
        const up = this.grids[k][blk].values;
        const th = this.thGrids[k][blk].values;
        const cur = this.grids[k + 1][blk].values;
        for (let i = 0; i < cur.length; i++) cur[i] = up[i] - th[i];
      }
    }
    // 正断层: 下降盘各地层界面 (不含地表) 整体减去断距
    const f = this.params.fault;
    const db = this.downthrownBlock();
    if (f.enabled && db >= 0 && f.throw !== 0) {
      for (let bi = 1; bi < this.nB; bi++) {
        const v = this.grids[bi][db].values;
        for (let i = 0; i < v.length; i++) v[i] -= f.throw;
      }
    }
  }

  private influenceRadius(): number {
    const p = this.params.interp;
    return Math.max(p.radius, p.variogram.range, 1);
  }

  /**
   * 局部更新: 只重算受影响孔影响域内的网格节点。
   * 返回重算的节点数; 若触发了全量重建返回 -1。
   */
  updateHoles(changed: string[], removed: { id: string }[] = []): number {
    if (this.grids.length === 0) { this.fullBuild(); return -1; }
    for (const id of changed) {
      const c = this.collars.get(id);
      if (!c) continue;
      const e = this.extent;
      if (c.x < e.x0 || c.x > e.x1 || c.y < e.y0 || c.y > e.y1) { this.fullBuild(); return -1; }
    }
    const R = this.influenceRadius();
    let cells = 0;

    const dropHole = (id: string): { dem?: Sample; th: (Sample | null)[] } => {
      const old = { dem: undefined as Sample | undefined, th: [] as (Sample | null)[] };
      for (let blk = 0; blk < 2; blk++) {
        const d = this.demSamples[blk].get(id);
        if (d) { old.dem = d; this.demSamples[blk].delete(id); }
        for (let k = 0; k < this.nLayers; k++) {
          const s = this.thSamples[k][blk].get(id);
          if (s) { old.th.push(s); this.thSamples[k][blk].delete(id); }
        }
      }
      return old;
    };
    const recomputeAt = (x: number, y: number) => {
      for (let blk = 0; blk < 2; blk++) {
        cells += recomputeRegion(this.demArray(blk), this.grids[0][blk], this.params.interp, x, y, R);
        for (let k = 0; k < this.nLayers; k++) {
          cells += recomputeRegion(this.thArray(k, blk), this.thGrids[k][blk], this.params.interp, x, y, R);
        }
      }
    };

    for (const id of changed) {
      const old = dropHole(id);
      if (old.dem) recomputeAt(old.dem.x, old.dem.y); // 旧位置影响域
      const hs = this.holeSamples(id);
      if (!hs) continue;
      this.paths.set(id, hs.path);
      const blk = this.faultSide(hs.dem.x, hs.dem.y);
      this.demSamples[blk].set(id, hs.dem);
      for (let k = 0; k < this.nLayers; k++) {
        const s = hs.th[k];
        if (s) this.thSamples[k][this.faultSide(s.x, s.y)].set(id, s);
      }
      recomputeAt(hs.dem.x, hs.dem.y); // 新位置影响域
    }
    for (const r of removed) {
      const old = dropHole(r.id);
      this.paths.delete(r.id);
      if (old.dem) recomputeAt(old.dem.x, old.dem.y);
    }
    this.deriveBoundaries();
    return cells;
  }

  // ---------- 网格剖分 (含断层线裁剪) ----------
  private buildTess() {
    this.tess = [0, 1].map(blk => this.buildBlockTess(blk));
  }

  private buildBlockTess(blk: number): Tess {
    const { gridNx: nx, gridNy: ny } = this.params;
    const e = this.extent;
    const dx = (e.x1 - e.x0) / (nx - 1), dy = (e.y1 - e.y0) / (ny - 1);
    const xy: number[] = [];
    const tris: number[] = [];
    const f = this.params.fault;
    const { sx, sy } = this.faultDir();
    const inside = (x: number, y: number) => {
      if (!f.enabled) return true;
      const cross = sx * (y - f.y) - sy * (x - f.x);
      return blk === 0 ? cross >= -1e-9 : cross <= 1e-9;
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) xy.push(e.x0 + i * dx, e.y0 + j * dy);
    const nodeIdx = (i: number, j: number) => j * nx + i;

    const edgeCount = new Map<string, number>();
    const edgeVerts = new Map<string, [number, number]>();
    const edgeKey = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;
    const addTri = (a: number, b: number, c: number) => {
      tris.push(a, b, c);
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        const k = edgeKey(p, q);
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
        if (!edgeVerts.has(k)) edgeVerts.set(k, a < b ? [a, b] : [b, a]);
      }
    };

    // 单元四边形按断层半平面裁剪 (Sutherland–Hodgman), 交点成为新顶点
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const quad = [nodeIdx(i, j), nodeIdx(i + 1, j), nodeIdx(i + 1, j + 1), nodeIdx(i, j + 1)];
        let poly: number[] = quad;
        if (f.enabled) {
          const allIn = quad.every(v => inside(xy[v * 2], xy[v * 2 + 1]));
          const allOut = quad.every(v => !inside(xy[v * 2], xy[v * 2 + 1]));
          if (allOut) continue;
          if (!allIn) {
            const newPoly: number[] = [];
            for (let k = 0; k < 4; k++) {
              const va = quad[k], vb = quad[(k + 1) % 4];
              const ax = xy[va * 2], ay = xy[va * 2 + 1];
              const bx = xy[vb * 2], by = xy[vb * 2 + 1];
              const inA = inside(ax, ay), inB = inside(bx, by);
              if (inA) newPoly.push(va);
              if (inA !== inB) {
                const ca = sx * (ay - f.y) - sy * (ax - f.x);
                const cb = sx * (by - f.y) - sy * (bx - f.x);
                const t = ca / (ca - cb);
                newPoly.push(xy.length / 2);
                xy.push(ax + (bx - ax) * t, ay + (by - ay) * t);
              }
            }
            poly = newPoly;
            if (poly.length < 3) continue;
          }
        }
        for (let k = 1; k + 1 < poly.length; k++) addTri(poly[0], poly[k], poly[k + 1]);
      }
    }
    const bnd: number[] = [];
    for (const [k, cnt] of edgeCount) {
      if (cnt === 1) {
        const [a, b] = edgeVerts.get(k)!;
        bnd.push(a, b);
      }
    }
    return { xy: new Float32Array(xy), tris: new Uint32Array(tris), bndEdges: new Uint32Array(bnd) };
  }

  // ---------- 取样 ----------
  /** 分界面 bi 在 (x,y) 处的高程 (按所在盘取对应网格; 超出网格范围时夹到边缘) */
  sampleBoundary(bi: number, x: number, y: number): number {
    const e = this.extent;
    const cx = Math.min(e.x1 - 1e-6, Math.max(e.x0 + 1e-6, x));
    const cy = Math.min(e.y1 - 1e-6, Math.max(e.y0 + 1e-6, y));
    const blk = this.faultSide(cx, cy);
    let z = this.grids[bi][blk].sample(cx, cy);
    if (Number.isNaN(z)) z = this.grids[bi][1 - blk].sample(cx, cy);
    return z;
  }

  // ---------- 网格 -> 面片数据 ----------
  private surfaceMesh(bi: number, blk: number): MeshData {
    const tess = this.tess[blk];
    const n = tess.xy.length / 2;
    const pos = new Float32Array(n * 3);
    const g = this.grids[bi][blk];
    for (let v = 0; v < n; v++) {
      const x = tess.xy[v * 2], y = tess.xy[v * 2 + 1];
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = g.sample(x, y);
    }
    const layerName = this.params.layerOrder[Math.min(bi, this.nLayers - 1)];
    return {
      name: `界面${bi}_${layerName}顶_${blk === 0 ? 'A盘' : 'B盘'}`,
      color: this.params.colors[layerName] ?? '#999999',
      positions: pos,
      indices: tess.tris,
    };
  }

  private volumeMesh(layer: number, blk: number): MeshData {
    const tess = this.tess[blk];
    const n = tess.xy.length / 2;
    const top = this.grids[layer][blk], bot = this.grids[layer + 1][blk];
    const pos = new Float32Array(n * 2 * 3);
    for (let v = 0; v < n; v++) {
      const x = tess.xy[v * 2], y = tess.xy[v * 2 + 1];
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = top.sample(x, y);
      pos[(n + v) * 3] = x; pos[(n + v) * 3 + 1] = y; pos[(n + v) * 3 + 2] = bot.sample(x, y);
    }
    const nt = tess.tris.length;
    const nw = tess.bndEdges.length / 2;
    const idx = new Uint32Array(nt * 2 + nw * 6);
    idx.set(tess.tris, 0);
    for (let t = 0; t < nt; t += 3) { // 底面反向
      idx[nt + t] = n + tess.tris[t + 2];
      idx[nt + t + 1] = n + tess.tris[t + 1];
      idx[nt + t + 2] = n + tess.tris[t];
    }
    // 裙边: 每条边界边 -> 连接顶底面的四边形 (外边界 + 断层崖壁), 形成封闭体
    let o = nt * 2;
    for (let eIdx = 0; eIdx < nw; eIdx++) {
      const a = tess.bndEdges[eIdx * 2], b = tess.bndEdges[eIdx * 2 + 1];
      idx[o++] = a; idx[o++] = b; idx[o++] = n + b;
      idx[o++] = a; idx[o++] = n + b; idx[o++] = n + a;
    }
    const layerName = this.params.layerOrder[layer];
    return {
      name: `地质体_${layerName}_${blk === 0 ? 'A盘' : 'B盘'}`,
      color: this.params.colors[layerName] ?? '#999999',
      positions: pos,
      indices: idx,
    };
  }

  buildSurfaces(): MeshData[] {
    const out: MeshData[] = [];
    for (let bi = 0; bi < this.nB; bi++) {
      for (let blk = 0; blk < 2; blk++) out.push(this.surfaceMesh(bi, blk));
    }
    return out;
  }

  buildVolumes(): MeshData[] {
    const out: MeshData[] = [];
    for (let k = 0; k < this.nLayers; k++) {
      for (let blk = 0; blk < 2; blk++) out.push(this.volumeMesh(k, blk));
    }
    return out;
  }
}
