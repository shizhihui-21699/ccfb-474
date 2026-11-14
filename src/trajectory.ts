// ============ 测斜换算: 最小曲率法 (minimum curvature) ============
import { Collar, SurveyStation } from './types';

export interface PathPoint {
  md: number;   // 沿孔迹深度
  tvd: number;  // 垂深
  dx: number;   // 相对孔口的东向位移
  dy: number;   // 相对孔口的北向位移
}

export interface Vec3 { x: number; y: number; z: number }

const D2R = Math.PI / 180;

/**
 * 由测斜数据计算真实孔迹 (最小曲率法)。
 * dip: 顶角(与铅垂夹角, 度); azimuth: 方位角(度)。
 * 返回相对孔口的偏移序列, 世界坐标 = 孔口 + (dx, dy, -tvd)。
 */
export function computePath(collar: Collar, stations: SurveyStation[]): PathPoint[] {
  const st = stations
    .filter(s => s.holeId === collar.id)
    .slice()
    .sort((a, b) => a.md - b.md);

  // 组装节点: 确保 md=0 与 md=depth 处有节点
  const nodes: { md: number; dip: number; az: number }[] = [];
  if (st.length === 0) {
    nodes.push({ md: 0, dip: 0, az: 0 });
  } else {
    if (st[0].md > 0) nodes.push({ md: 0, dip: st[0].dip, az: st[0].azimuth });
    for (const s of st) nodes.push({ md: s.md, dip: s.dip, az: s.azimuth });
  }
  const last = nodes[nodes.length - 1];
  if (collar.depth > last.md) nodes.push({ md: collar.depth, dip: last.dip, az: last.az });

  const path: PathPoint[] = [{ md: 0, tvd: 0, dx: 0, dy: 0 }];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const seg = b.md - a.md;
    if (seg <= 0) continue;
    const I1 = a.dip * D2R, I2 = b.dip * D2R;
    const A1 = a.az * D2R, A2 = b.az * D2R;
    const prev = path[path.length - 1];

    const cosDL = Math.cos(I1) * Math.cos(I2) + Math.sin(I1) * Math.sin(I2) * Math.cos(A2 - A1);
    const DL = Math.acos(Math.min(1, Math.max(-1, cosDL)));
    const rf = DL > 1e-9 ? (2 / DL) * Math.tan(DL / 2) : 1;

    path.push({
      md: b.md,
      tvd: prev.tvd + (seg / 2) * (Math.cos(I1) + Math.cos(I2)) * rf,
      dx: prev.dx + (seg / 2) * (Math.sin(I1) * Math.sin(A1) + Math.sin(I2) * Math.sin(A2)) * rf,
      dy: prev.dy + (seg / 2) * (Math.sin(I1) * Math.cos(A1) + Math.sin(I2) * Math.cos(A2)) * rf,
    });
  }
  return path;
}

/** 在孔迹上按测深插值出一点 (相对孔口偏移) */
export function pointAtMd(path: PathPoint[], md: number): PathPoint {
  if (md <= 0 || path.length === 0) return path[0] ?? { md: 0, tvd: 0, dx: 0, dy: 0 };
  const last = path[path.length - 1];
  if (md >= last.md) return last;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].md <= md) lo = mid; else hi = mid;
  }
  const a = path[lo], b = path[hi];
  const t = (md - a.md) / (b.md - a.md);
  return {
    md,
    tvd: a.tvd + (b.tvd - a.tvd) * t,
    dx: a.dx + (b.dx - a.dx) * t,
    dy: a.dy + (b.dy - a.dy) * t,
  };
}

/** 按垂深(tvd)反查孔迹点 */
export function pointAtTvd(path: PathPoint[], tvd: number): PathPoint {
  if (tvd <= 0 || path.length === 0) return path[0] ?? { md: 0, tvd: 0, dx: 0, dy: 0 };
  const last = path[path.length - 1];
  if (tvd >= last.tvd) return last;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].tvd <= tvd) lo = mid; else hi = mid;
  }
  const a = path[lo], b = path[hi];
  const t = (tvd - a.tvd) / (b.tvd - a.tvd || 1e-9);
  return {
    md: a.md + (b.md - a.md) * t,
    tvd,
    dx: a.dx + (b.dx - a.dx) * t,
    dy: a.dy + (b.dy - a.dy) * t,
  };
}

/** 孔迹点 -> 世界坐标 */
export function toWorld(collar: Collar, p: PathPoint): Vec3 {
  return { x: collar.x + p.dx, y: collar.y + p.dy, z: collar.z - p.tvd };
}

/** 沿孔迹均匀采样 (用于绘制岩芯柱/孔迹线) */
export function samplePath(path: PathPoint[], step: number): PathPoint[] {
  const out: PathPoint[] = [];
  const total = path[path.length - 1]?.md ?? 0;
  for (let md = 0; md < total; md += step) out.push(pointAtMd(path, md));
  if (total > 0) out.push(path[path.length - 1]);
  return out;
}
