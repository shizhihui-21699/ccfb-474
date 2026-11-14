// ============ 三张表一致性校验 ============
import { Collar, SurveyStation, LithoInterval, Issue, ModelParams } from './types';

export interface ValidationResult {
  issues: Issue[];
  /** holeId -> 该孔的所有问题 (用于表格标红) */
  byHole: Map<string, Issue[]>;
}

export function validate(
  collars: Collar[],
  surveys: SurveyStation[],
  lithos: LithoInterval[],
  params: ModelParams,
): ValidationResult {
  const issues: Issue[] = [];
  const collarIds = new Set<string>();
  const collarMap = new Map<string, Collar>();

  collars.forEach((c, i) => {
    if (!c.id.trim()) {
      issues.push({ table: 'collar', holeId: c.id, row: i, message: '孔号为空' });
      return;
    }
    if (collarIds.has(c.id)) {
      issues.push({ table: 'collar', holeId: c.id, row: i, message: `孔号 "${c.id}" 重复` });
    }
    if (!(c.depth > 0)) {
      issues.push({ table: 'collar', holeId: c.id, row: i, message: '孔深必须为正数' });
    }
    collarIds.add(c.id);
    collarMap.set(c.id, c);
  });

  surveys.forEach((s, i) => {
    if (!collarIds.has(s.holeId)) {
      issues.push({ table: 'survey', holeId: s.holeId, row: i, message: `测斜记录引用了不存在的孔 "${s.holeId}"` });
      return;
    }
    const c = collarMap.get(s.holeId)!;
    if (s.md < 0) issues.push({ table: 'survey', holeId: s.holeId, row: i, message: '测深为负' });
    if (s.md > c.depth + 0.01) issues.push({ table: 'survey', holeId: s.holeId, row: i, message: `测深 ${s.md}m 超出孔深 ${c.depth}m` });
    if (s.dip < 0 || s.dip > 90) issues.push({ table: 'survey', holeId: s.holeId, row: i, message: `顶角 ${s.dip}° 超出 [0,90]` });
    if (s.azimuth < 0 || s.azimuth >= 360) issues.push({ table: 'survey', holeId: s.holeId, row: i, message: `方位角 ${s.azimuth}° 超出 [0,360)` });
  });

  // 每孔测斜按深度排序后检查重复测深
  const byHoleSurvey = new Map<string, SurveyStation[]>();
  for (const s of surveys) {
    if (!byHoleSurvey.has(s.holeId)) byHoleSurvey.set(s.holeId, []);
    byHoleSurvey.get(s.holeId)!.push(s);
  }
  for (const [hid, arr] of byHoleSurvey) {
    arr.sort((a, b) => a.md - b.md);
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i].md - arr[i - 1].md) < 1e-6) {
        issues.push({ table: 'survey', holeId: hid, row: -1, message: `测深 ${arr[i].md}m 重复` });
      }
    }
  }

  lithos.forEach((l, i) => {
    if (!collarIds.has(l.holeId)) {
      issues.push({ table: 'litho', holeId: l.holeId, row: i, message: `分层记录引用了不存在的孔 "${l.holeId}"` });
      return;
    }
    const c = collarMap.get(l.holeId)!;
    if (l.to <= l.from) issues.push({ table: 'litho', holeId: l.holeId, row: i, message: `层段 [${l.from}, ${l.to}] 起止深度颠倒` });
    if (l.from < -0.01) issues.push({ table: 'litho', holeId: l.holeId, row: i, message: '起始深度为负' });
    if (l.to > c.depth + 0.5) issues.push({ table: 'litho', holeId: l.holeId, row: i, message: `层底 ${l.to}m 超出孔深 ${c.depth}m` });
    if (!params.layerOrder.includes(l.litho)) {
      issues.push({ table: 'litho', holeId: l.holeId, row: i, message: `岩性 "${l.litho}" 不在地层表中, 建模时将被忽略` });
    }
  });

  // 每孔分层重叠检查
  const byHoleLitho = new Map<string, LithoInterval[]>();
  for (const l of lithos) {
    if (!collarIds.has(l.holeId)) continue;
    if (!byHoleLitho.has(l.holeId)) byHoleLitho.set(l.holeId, []);
    byHoleLitho.get(l.holeId)!.push(l);
  }
  for (const [hid, arr] of byHoleLitho) {
    arr.sort((a, b) => a.from - b.from);
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].from < arr[i - 1].to - 0.01) {
        issues.push({ table: 'litho', holeId: hid, row: -1, message: `层段 [${arr[i].from},${arr[i].to}] 与上一层重叠` });
      }
    }
  }

  // 有测斜/分层但缺孔口的孔已在上面标出; 反向: 孔口无分层仅提示
  for (const c of collars) {
    if (!byHoleLitho.has(c.id)) {
      issues.push({ table: 'collar', holeId: c.id, row: -1, message: `孔 "${c.id}" 没有分层数据` });
    }
  }

  const byHole = new Map<string, Issue[]>();
  for (const iss of issues) {
    if (!byHole.has(iss.holeId)) byHole.set(iss.holeId, []);
    byHole.get(iss.holeId)!.push(iss);
  }
  return { issues, byHole };
}
