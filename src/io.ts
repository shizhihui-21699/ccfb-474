// ============ IO: CSV 导入 / 工程保存 / OBJ 导出 ============
import { Collar, SurveyStation, LithoInterval, Project } from './types';
import { MeshData } from './model';

// ---------- CSV 解析 ----------
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [], field = '', inQ = false;
  const push = () => { cur.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === '\t' || ch === ';') push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      push();
      if (cur.some(c => c.trim() !== '')) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  push();
  if (cur.some(c => c.trim() !== '')) rows.push(cur);
  return rows;
}

function findCol(header: string[], candidates: string[]): number {
  const norm = header.map(h => h.trim().toLowerCase().replace(/[\s_\-()（）]/g, ''));
  for (const c of candidates) {
    const nc = c.toLowerCase().replace(/[\s_\-()（）]/g, '');
    const idx = norm.findIndex(h => h === nc || h.includes(nc));
    if (idx >= 0) return idx;
  }
  return -1;
}

const num = (s: string | undefined): number => {
  const v = parseFloat((s ?? '').trim());
  return isFinite(v) ? v : NaN;
};

export function parseCollarCSV(text: string): { rows: Collar[]; errors: string[] } {
  const table = parseCSV(text);
  const errors: string[] = [];
  if (table.length < 2) return { rows: [], errors: ['孔口表为空或缺少表头'] };
  const h = table[0];
  const cId = findCol(h, ['孔号', 'holeid', 'id', '钻孔编号', 'hole']);
  const cX = findCol(h, ['孔口x', 'x坐标', 'easting', 'x', '东坐标', '东距']);
  const cY = findCol(h, ['孔口y', 'y坐标', 'northing', 'y', '北坐标', '北距']);
  const cZ = findCol(h, ['孔口标高', '标高', 'z', 'elevation', 'elev', '孔口z', 'h']);
  const cD = findCol(h, ['孔深', '终孔深度', 'depth', '终孔']);
  if (cId < 0 || cX < 0 || cY < 0 || cZ < 0 || cD < 0) {
    errors.push(`表头识别失败, 需要: 孔号/X/Y/标高/孔深, 实际: ${h.join(',')}`);
    return { rows: [], errors };
  }
  const rows: Collar[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const c: Collar = { id: (r[cId] ?? '').trim(), x: num(r[cX]), y: num(r[cY]), z: num(r[cZ]), depth: num(r[cD]) };
    if (!c.id) { errors.push(`第${i}行: 孔号为空`); continue; }
    if (!isFinite(c.x) || !isFinite(c.y) || !isFinite(c.z) || !isFinite(c.depth)) {
      errors.push(`第${i}行 (${c.id}): 坐标/标高/孔深含非数字`);
      continue;
    }
    rows.push(c);
  }
  return { rows, errors };
}

export function parseSurveyCSV(text: string): { rows: SurveyStation[]; errors: string[] } {
  const table = parseCSV(text);
  const errors: string[] = [];
  if (table.length < 2) return { rows: [], errors: ['测斜表为空或缺少表头'] };
  const h = table[0];
  const cId = findCol(h, ['孔号', 'holeid', 'id', 'hole']);
  const cM = findCol(h, ['测深', '深度', 'md', 'depth']);
  const cD = findCol(h, ['顶角', '倾角', 'dip', 'inclination', 'inc']);
  const cA = findCol(h, ['方位角', '方位', 'azimuth', 'azi', 'az']);
  if (cId < 0 || cM < 0 || cD < 0 || cA < 0) {
    errors.push(`表头识别失败, 需要: 孔号/测深/顶角/方位角, 实际: ${h.join(',')}`);
    return { rows: [], errors };
  }
  const rows: SurveyStation[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const s: SurveyStation = { holeId: (r[cId] ?? '').trim(), md: num(r[cM]), dip: num(r[cD]), azimuth: num(r[cA]) };
    if (!s.holeId) { errors.push(`第${i}行: 孔号为空`); continue; }
    if (!isFinite(s.md) || !isFinite(s.dip) || !isFinite(s.azimuth)) {
      errors.push(`第${i}行 (${s.holeId}): 含非数字`);
      continue;
    }
    rows.push(s);
  }
  return { rows, errors };
}

export function parseLithoCSV(text: string): { rows: LithoInterval[]; errors: string[] } {
  const table = parseCSV(text);
  const errors: string[] = [];
  if (table.length < 2) return { rows: [], errors: ['分层表为空或缺少表头'] };
  const h = table[0];
  const cId = findCol(h, ['孔号', 'holeid', 'id', 'hole']);
  const cF = findCol(h, ['起始深度', '自', 'from', '顶深', '层顶']);
  const cT = findCol(h, ['终止深度', '至', 'to', '底深', '层底']);
  const cL = findCol(h, ['岩性', '岩层', 'litho', 'lithology', '地层']);
  if (cId < 0 || cF < 0 || cT < 0 || cL < 0) {
    errors.push(`表头识别失败, 需要: 孔号/起始深度/终止深度/岩性, 实际: ${h.join(',')}`);
    return { rows: [], errors };
  }
  const rows: LithoInterval[] = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const l: LithoInterval = { holeId: (r[cId] ?? '').trim(), from: num(r[cF]), to: num(r[cT]), litho: (r[cL] ?? '').trim() };
    if (!l.holeId) { errors.push(`第${i}行: 孔号为空`); continue; }
    if (!isFinite(l.from) || !isFinite(l.to) || !l.litho) {
      errors.push(`第${i}行 (${l.holeId}): 含非数字或岩性为空`);
      continue;
    }
    rows.push(l);
  }
  return { rows, errors };
}

// ---------- 工程保存 / 打开 ----------
export function serializeProject(p: Project): string {
  return JSON.stringify({ format: 'geo3d-project', version: 1, ...p }, null, 1);
}

export function deserializeProject(text: string): Project {
  const obj = JSON.parse(text);
  if (obj.format !== 'geo3d-project') throw new Error('不是本工具的工程文件');
  return {
    collars: obj.collars ?? [],
    surveys: obj.surveys ?? [],
    lithos: obj.lithos ?? [],
    params: obj.params,
    sections: obj.sections ?? [],
  };
}

export function downloadFile(name: string, content: string | Blob, mime = 'text/plain'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

// ---------- OBJ 导出 ----------
export function exportOBJ(meshes: MeshData[]): { obj: string; mtl: string } {
  const objLines: string[] = ['# geo3d-modeler export', 'mtllib model.mtl'];
  const mtlLines: string[] = ['# materials'];
  const matOf = new Map<string, string>();
  let vOffset = 1;
  for (const m of meshes) {
    const safeName = m.name.replace(/\s+/g, '_');
    let mat = matOf.get(m.color);
    if (!mat) {
      mat = `mat_${matOf.size}`;
      matOf.set(m.color, mat);
      const c = m.color.replace('#', '');
      const r = parseInt(c.slice(0, 2), 16) / 255;
      const g = parseInt(c.slice(2, 4), 16) / 255;
      const b = parseInt(c.slice(4, 6), 16) / 255;
      mtlLines.push(`newmtl ${mat}`, `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`, 'Ka 0.1 0.1 0.1', 'Ks 0.2 0.2 0.2', '');
    }
    objLines.push(`o ${safeName}`, `usemtl ${mat}`);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      objLines.push(`v ${p[i].toFixed(3)} ${p[i + 1].toFixed(3)} ${p[i + 2].toFixed(3)}`);
    }
    const idx = m.indices;
    for (let i = 0; i < idx.length; i += 3) {
      objLines.push(`f ${idx[i] + vOffset} ${idx[i + 1] + vOffset} ${idx[i + 2] + vOffset}`);
    }
    vOffset += p.length / 3;
  }
  return { obj: objLines.join('\n'), mtl: mtlLines.join('\n') };
}
