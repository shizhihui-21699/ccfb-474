// ============ 剖面: 沿任意折线切割模型 ============
import { GeoModel, MeshData } from './model';
import { SectionDef } from './types';
import { pointAtMd } from './trajectory';

export interface SectionStation {
  s: number;      // 沿剖面线里程
  x: number; y: number;
  block: number;  // 所在断层盘
}

export interface SectionData {
  def: SectionDef;
  stations: SectionStation[];
  /** surf[bi][si] = 分界面高程 */
  surf: number[][];
  totalLen: number;
  /** 断层与剖面交点的里程列表 */
  faultCrossings: number[];
  /** 走廊内投影进来的钻孔 */
  holes: {
    id: string; s: number; dist: number;
    segs: { zTop: number; zBot: number; litho: string }[];
    collarZ: number;
  }[];
}

/** 折线重采样为等间距站点 */
function resample(pts: { x: number; y: number }[], step: number): SectionStation[] {
  const out: SectionStation[] = [];
  let s = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push({ s: s + t * len, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, block: 0 });
    }
    s += len;
  }
  const last = pts[pts.length - 1];
  out.push({ s, x: last.x, y: last.y, block: 0 });
  return out;
}

export function cutSection(model: GeoModel, def: SectionDef): SectionData {
  const e = model.extent;
  const diag = Math.hypot(e.x1 - e.x0, e.y1 - e.y0);
  const step = Math.max(1, diag / 300);
  const stations = resample(def.pts, step);
  for (const st of stations) st.block = model.faultSide(st.x, st.y);

  const surf: number[][] = [];
  for (let bi = 0; bi < model.nB; bi++) {
    surf.push(stations.map(st => model.sampleBoundary(bi, st.x, st.y)));
  }

  // 断层交点里程
  const faultCrossings: number[] = [];
  for (let i = 1; i < stations.length; i++) {
    if (stations[i].block !== stations[i - 1].block) {
      faultCrossings.push((stations[i].s + stations[i - 1].s) / 2);
    }
  }

  // 走廊内钻孔投影
  const holes: SectionData['holes'] = [];
  for (const [id, path] of model.paths) {
    const c = model.collars.get(id)!;
    // 孔口到折线的最近里程与距离
    let bestS = 0, bestD = Infinity;
    for (const st of stations) {
      const d = Math.hypot(st.x - c.x, st.y - c.y);
      if (d < bestD) { bestD = d; bestS = st.s; }
    }
    if (bestD > def.corridor) continue;
    const segs: { zTop: number; zBot: number; litho: string }[] = [];
    for (const l of model.lithos.get(id) ?? []) {
      const p1 = pointAtMd(path, l.from), p2 = pointAtMd(path, l.to);
      segs.push({ zTop: c.z - p1.tvd, zBot: c.z - p2.tvd, litho: l.litho });
    }
    holes.push({ id, s: bestS, dist: bestD, segs, collarZ: c.z });
  }

  return { def, stations, surf, totalLen: stations[stations.length - 1].s, faultCrossings, holes };
}

/** 三维中的切割面 (每层一条帘幕) */
export function buildCurtainMeshes(model: GeoModel, data: SectionData): MeshData[] {
  const out: MeshData[] = [];
  const n = data.stations.length;
  for (let layer = 0; layer < model.nLayers; layer++) {
    const pos = new Float32Array(n * 2 * 3);
    const idx = new Uint32Array((n - 1) * 6);
    for (let i = 0; i < n; i++) {
      const st = data.stations[i];
      pos[i * 3] = st.x; pos[i * 3 + 1] = st.y; pos[i * 3 + 2] = data.surf[layer][i];
      pos[(n + i) * 3] = st.x; pos[(n + i) * 3 + 1] = st.y; pos[(n + i) * 3 + 2] = data.surf[layer + 1][i];
    }
    let o = 0;
    for (let i = 0; i < n - 1; i++) {
      idx[o++] = i; idx[o++] = i + 1; idx[o++] = n + i + 1;
      idx[o++] = i; idx[o++] = n + i + 1; idx[o++] = n + i;
    }
    const layerName = model.params.layerOrder[layer];
    out.push({
      name: `剖面_${data.def.name}_${layerName}`,
      color: model.params.colors[layerName] ?? '#999999',
      positions: pos, indices: idx,
    });
  }
  return out;
}

/** 二维剖面绘制到 canvas */
export function drawSection2D(canvas: HTMLCanvasElement, model: GeoModel, data: SectionData): void {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 900, H = canvas.clientHeight || 320;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, W, H);

  const marginL = 60, marginR = 20, marginT = 30, marginB = 36;
  const plotW = W - marginL - marginR, plotH = H - marginT - marginB;

  let zMin = Infinity, zMax = -Infinity;
  for (const row of data.surf) for (const z of row) {
    if (Number.isNaN(z)) continue;
    zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
  }
  if (!isFinite(zMin)) return;
  const zPad = (zMax - zMin) * 0.08 + 1;
  zMin -= zPad; zMax += zPad;
  // 垂向放大 2 倍显示
  const ve = 2;
  const zRange = (zMax - zMin) * ve;
  const sx = (s: number) => marginL + (s / data.totalLen) * plotW;
  const sy = (z: number) => marginT + ((zMax - z) * ve / zRange) * plotH;

  // 分层填充 (按断层盘分段, 断层处自然断开)
  const n = data.stations.length;
  for (let layer = 0; layer < model.nLayers; layer++) {
    const color = model.params.colors[model.params.layerOrder[layer]] ?? '#999';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    let runStart = 0;
    while (runStart < n) {
      const blk = data.stations[runStart].block;
      let runEnd = runStart;
      while (runEnd + 1 < n && data.stations[runEnd + 1].block === blk) runEnd++;
      ctx.beginPath();
      let started = false;
      for (let i = runStart; i <= runEnd; i++) {
        const z = data.surf[layer][i];
        if (Number.isNaN(z)) continue;
        const px = sx(data.stations[i].s), py = sy(z);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      for (let i = runEnd; i >= runStart; i--) {
        const z = data.surf[layer + 1][i];
        if (Number.isNaN(z)) continue;
        ctx.lineTo(sx(data.stations[i].s), sy(z));
      }
      ctx.closePath();
      ctx.fill();
      runStart = runEnd + 1;
    }
  }
  ctx.globalAlpha = 1;

  // 界面线
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  for (let bi = 0; bi < model.nB; bi++) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const z = data.surf[bi][i];
      if (Number.isNaN(z)) { started = false; continue; }
      const px = sx(data.stations[i].s), py = sy(z);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // 断层线
  ctx.strokeStyle = '#ff5555';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  for (const fc of data.faultCrossings) {
    ctx.beginPath();
    ctx.moveTo(sx(fc), marginT);
    ctx.lineTo(sx(fc), marginT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#ff5555';
    ctx.font = '11px sans-serif';
    ctx.fillText('断层', sx(fc) + 3, marginT + 12);
  }
  ctx.setLineDash([]);

  // 投影钻孔
  for (const h of data.holes) {
    const px = sx(h.s);
    const w = 3;
    for (const seg of h.segs) {
      ctx.fillStyle = model.params.colors[seg.litho] ?? '#aaa';
      ctx.fillRect(px - w / 2, sy(seg.zTop), w, Math.max(1, sy(seg.zBot) - sy(seg.zTop)));
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(px - w / 2, sy(h.collarZ), w, sy(h.segs[h.segs.length - 1]?.zBot ?? h.collarZ) - sy(h.collarZ));
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.save();
    ctx.translate(px + 2, sy(h.collarZ) - 4);
    ctx.fillText(h.id, 0, 0);
    ctx.restore();
  }

  // 坐标轴
  ctx.strokeStyle = '#8a93a3';
  ctx.fillStyle = '#c8cfdb';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.beginPath();
  ctx.moveTo(marginL, marginT); ctx.lineTo(marginL, marginT + plotH); ctx.lineTo(marginL + plotW, marginT + plotH);
  ctx.stroke();
  // 高程刻度
  const zStep = niceStep((zMax - zMin) / 5);
  for (let z = Math.ceil(zMin / zStep) * zStep; z <= zMax; z += zStep) {
    const py = sy(z);
    ctx.strokeStyle = 'rgba(138,147,163,0.3)';
    ctx.beginPath(); ctx.moveTo(marginL, py); ctx.lineTo(marginL + plotW, py); ctx.stroke();
    ctx.fillStyle = '#c8cfdb';
    ctx.textAlign = 'right';
    ctx.fillText(z.toFixed(0) + 'm', marginL - 6, py + 4);
  }
  // 里程刻度
  const sStep = niceStep(data.totalLen / 6);
  ctx.textAlign = 'center';
  for (let s = 0; s <= data.totalLen; s += sStep) {
    const px = sx(s);
    ctx.fillText(s.toFixed(0) + 'm', px, marginT + plotH + 16);
  }
  // 标题
  ctx.textAlign = 'left';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#e6ebf2';
  ctx.fillText(`${data.def.name}  (总长 ${data.totalLen.toFixed(0)}m, 垂向放大 ${ve}×)`, marginL, 18);
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const t = raw / mag;
  if (t < 1.5) return mag;
  if (t < 3) return 2 * mag;
  if (t < 7) return 5 * mag;
  return 10 * mag;
}
