// ============ 核心算法冒烟测试 (node, 不依赖 DOM/three) ============
import { generateSample, generateStressTest } from '../src/sample';
import { GeoModel } from '../src/model';
import { validate } from '../src/validate';
import { computePath } from '../src/trajectory';
import { cutSection, buildCurtainMeshes } from '../src/section';
import { exportOBJ, parseCollarCSV, parseSurveyCSV, parseLithoCSV, serializeProject, deserializeProject } from '../src/io';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

console.log('== 示例数据 ==');
const proj = generateSample();
check('36 个孔', proj.collars.length === 36, `got ${proj.collars.length}`);
check('测斜/分层非空', proj.surveys.length > 100 && proj.lithos.length > 100);

const v = validate(proj.collars, proj.surveys, proj.lithos, proj.params);
check('示例数据校验通过', v.issues.length === 0, v.issues.slice(0, 5).map(i => i.message).join('; '));

// 校验能抓出对不上的孔
const bad = validate(
  proj.collars,
  [...proj.surveys, { holeId: 'ZK-999', md: 10, dip: 1, azimuth: 90 }],
  proj.lithos,
  proj.params,
);
check('孤儿测斜记录被标出', bad.issues.some(i => i.holeId === 'ZK-999'));

console.log('== 测斜换算 ==');
const collar = proj.collars[0];
const path = computePath(collar, proj.surveys.filter(s => s.holeId === collar.id));
const lastP = path[path.length - 1];
check('孔迹深度覆盖孔深', Math.abs(lastP.md - collar.depth) < 0.01);
check('斜孔 tvd < md', lastP.tvd < lastP.md, `tvd=${lastP.tvd} md=${lastP.md}`);
check('位移有限', Math.abs(lastP.dx) < 50 && Math.abs(lastP.dy) < 50);

console.log('== 建模 ==');
const model = new GeoModel(proj.params);
model.setData(proj.collars, proj.surveys, proj.lithos);
let t0 = performance.now();
model.fullBuild();
const buildMs = performance.now() - t0;
console.log(`  全量建模 ${buildMs.toFixed(0)}ms`);
check('分界面数 = 层数+1', model.nB === 6);
check('网格无 NaN', model.grids.every(row => row.every(g => [...g.values].every(x => !Number.isNaN(x)))));

// 尖灭: 页岩(第3层, index 2) 在东侧厚度应为 0 (按所在断层盘取样)
const e = model.extent;
const midY = (e.y0 + e.y1) / 2;
const zT = model.sampleBoundary(2, e.x1 - 2, midY);
const zB = model.sampleBoundary(3, e.x1 - 2, midY);
check('东侧页岩尖灭 (零厚度)', Math.abs(zT - zB) < 1.0, `top=${zT} bot=${zB}`);
const zTw = model.sampleBoundary(2, e.x0 + 2, midY);
const zBw = model.sampleBoundary(3, e.x0 + 2, midY);
check('西侧页岩有厚度', zTw - zBw > 5, `thickness=${zTw - zBw}`);

// 断层: 两侧界面高程应有跳变
if (proj.params.fault.enabled) {
  const f = proj.params.fault;
  // 沿断层法向取一对点
  const dAz = (proj.params.fault.strike + 90) * Math.PI / 180;
  const d = { dx: Math.sin(dAz), dy: Math.cos(dAz) };
  const z1 = model.sampleBoundary(1, f.x - d.dx * 8, f.y - d.dy * 8);
  const z2 = model.sampleBoundary(1, f.x + d.dx * 8, f.y + d.dy * 8);
  check('断层两侧界面不连续', Math.abs(z1 - z2) > 4, `sideA=${z1.toFixed(1)} sideB=${z2.toFixed(1)}`);
}

// 封闭体
const vols = model.buildVolumes();
check('地质体数量 = 层数×2盘', vols.length === 10, `got ${vols.length}`);
check('体网格索引闭合(顶+底+裙边)', vols.every(m => m.indices.length > 0 && m.positions.length > 0));

console.log('== 局部重算 ==');
model.setData(proj.collars, proj.surveys, proj.lithos);
const target = proj.collars[5];
const before = [model.grids[2][0].values.slice(), model.grids[2][1].values.slice()]; // 砂岩底界面, 两盘
const changedLitho = proj.lithos.map(l =>
  l.holeId === target.id && l.litho === '砂岩' ? { ...l, to: l.to + 5 } : l);
model.setData(proj.collars, proj.surveys, changedLitho);
t0 = performance.now();
const cells = model.updateHoles([target.id], []);
const incMs = performance.now() - t0;
const totalCells = model.grids[2][0].values.length + model.grids[2][1].values.length;
let diffCells = 0;
for (let b = 0; b < 2; b++) {
  const after = model.grids[2][b].values;
  for (let i = 0; i < after.length; i++) if (before[b][i] !== after[i]) diffCells++;
}
console.log(`  局部重算 ${cells} 节点, ${incMs.toFixed(1)}ms, 砂岩底界面变化 ${diffCells} 节点`);
check('局部重算只改局部', diffCells > 0 && diffCells < totalCells * 0.6,
  `${diffCells}/${totalCells}`);
check('局部重算显著快于全量', incMs < buildMs, `${incMs} vs ${buildMs}`);

console.log('== 剖面 ==');
const sec = cutSection(model, proj.sections[0]);
check('剖面站点数 > 50', sec.stations.length > 50);
check('剖面穿过断层', sec.faultCrossings.length >= 1, `got ${sec.faultCrossings.length}`);
check('走廊内投影到钻孔', sec.holes.length > 3, `got ${sec.holes.length}`);
const curtains = buildCurtainMeshes(model, sec);
check('帘幕网格 = 层数', curtains.length === 5);

console.log('== IO ==');
const { obj, mtl } = exportOBJ(vols);
check('OBJ 含顶点与面', obj.includes('v ') && obj.includes('f ') && obj.includes('usemtl'));
check('MTL 含材质', mtl.includes('newmtl'));
const roundtrip = deserializeProject(serializeProject(proj));
check('工程保存/打开往返一致', roundtrip.collars.length === proj.collars.length &&
  roundtrip.params.layerOrder.join() === proj.params.layerOrder.join());

const csvC = '孔号,X,Y,标高,孔深\nZK-A,10,20,100,50\n';
check('CSV 孔口解析', parseCollarCSV(csvC).rows[0]?.id === 'ZK-A');
const csvS = 'hole,md,dip,azimuth\nZK-A,10,1.5,90\n';
check('CSV 测斜解析(英文表头)', parseSurveyCSV(csvS).rows[0]?.dip === 1.5);
const csvL = '孔号,起始深度,终止深度,岩性\nZK-A,0,10,砂岩\n';
check('CSV 分层解析', parseLithoCSV(csvL).rows[0]?.litho === '砂岩');

console.log('== 200 孔压力测试 ==');
const big = generateStressTest(200);
const bigModel = new GeoModel(big.params);
bigModel.setData(big.collars, big.surveys, big.lithos);
t0 = performance.now();
bigModel.fullBuild();
console.log(`  200 孔全量建模 ${(performance.now() - t0).toFixed(0)}ms`);
const bigVols = bigModel.buildVolumes();
let totalTris = 0;
for (const m of bigVols) totalTris += m.indices.length / 3;
console.log(`  地质体总三角形 ${(totalTris / 1000).toFixed(0)}k`);
check('200 孔建模成功', bigVols.length === 10);

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);

declare const process: { exit(code: number): void };
