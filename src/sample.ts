// ============ 示例数据: 36 孔, 含页岩尖灭层与一条正断层 ============
import { Project, Collar, SurveyStation, LithoInterval, defaultParams } from './types';
import { computePath, pointAtTvd } from './trajectory';

/** 可复现的伪随机数 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSample(seed = 20240101, nx = 6, ny = 6): Project {
  const rand = mulberry32(seed);
  const params = defaultParams();
  const fault = params.fault;
  const D2R = Math.PI / 180;
  const sx = Math.sin(fault.strike * D2R), sy = Math.cos(fault.strike * D2R);
  // 倾向方向 (下降盘一侧)
  const ddx = Math.sin((fault.strike + 90) * D2R), ddy = Math.cos((fault.strike + 90) * D2R);

  const spacing = 45;
  const collars: Collar[] = [];
  const surveys: SurveyStation[] = [];
  const lithos: LithoInterval[] = [];

  const dem = (x: number, y: number) =>
    100 + 0.05 * x - 0.03 * y + 3 * Math.sin(x / 55) + 2 * Math.cos(y / 40);

  let holeNo = 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * spacing + (rand() - 0.5) * 24;
      const y = j * spacing + (rand() - 0.5) * 24;
      const z0 = dem(x, y);
      const id = `ZK-${holeNo++}`;

      // 该孔是否在下降盘
      const cross = sx * (y - fault.y) - sy * (x - fault.x);
      const px = x - fault.x, py = y - fault.y;
      const onDownthrown = (px * ddx + py * ddy) > 0 && fault.enabled;
      const off = onDownthrown ? fault.throw : 0;

      // 真垂深方向的层界面高程
      const B: number[] = [z0];
      B.push(B[0] - (4 + 2 * rand()));                    // 覆盖层底
      B.push(B[1] - (12 + 3 * rand()));                   // 砂岩底
      const shale = Math.max(0, 16 - 0.12 * (x - 40) + (rand() - 0.5) * 2); // 页岩向东尖灭
      B.push(B[2] - shale);                               // 页岩底
      B.push(B[3] - (18 + 4 * rand()));                   // 灰岩底
      B.push(B[4] - (25 + 8 * rand()));                   // 花岗岩内终孔
      // 正断层: 下降盘各界面整体下落 (地表不变)
      for (let k = 1; k < B.length; k++) B[k] -= off;

      const depth = B[0] - B[5]; // 孔深(近似, 后面按孔迹换算)

      // 测斜: 顶角随机游走
      const st: SurveyStation[] = [];
      let dip = 0.3 + rand() * 1.2, az = rand() * 360;
      for (let md = 0; md <= depth + 1; md += 20 + rand() * 10) {
        st.push({ holeId: id, md: Math.min(md, depth), dip, azimuth: ((az % 360) + 360) % 360 });
        dip = Math.max(0.1, Math.min(4, dip + (rand() - 0.5) * 0.8));
        az += (rand() - 0.5) * 16;
      }
      surveys.push(...st);

      // 由测斜算孔迹, 再按界面垂深反算测深 -> 分层表
      const collar: Collar = { id, x, y, z: z0, depth };
      const path = computePath(collar, st);
      const mdOf = (elev: number) => pointAtTvd(path, z0 - elev).md;
      const mds = B.map(elev => mdOf(elev));
      collar.depth = mds[5];
      collars.push(collar);

      const layerNames = params.layerOrder;
      for (let k = 0; k < 5; k++) {
        const from = mds[k], to = mds[k + 1];
        if (to - from < 0.05) continue; // 尖灭处该层缺失
        lithos.push({ holeId: id, from: +from.toFixed(2), to: +to.toFixed(2), litho: layerNames[k] });
      }
    }
  }

  return {
    collars, surveys, lithos, params,
    sections: [{
      name: '剖面1',
      pts: [{ x: -20, y: 110 }, { x: 110, y: 110 }, { x: 250, y: 60 }],
      corridor: 20,
    }],
  };
}

/** 压力测试: 生成 count 个孔 (默认 200) */
export function generateStressTest(count = 200): Project {
  const proj = generateSample(777, 1, 1);
  proj.collars = []; proj.surveys = []; proj.lithos = [];
  const rand = mulberry32(42);
  const n = Math.ceil(Math.sqrt(count));
  const spacing = 22;
  const params = proj.params;
  const D2R = Math.PI / 180;
  const fault = params.fault;
  const sx = Math.sin(fault.strike * D2R), sy = Math.cos(fault.strike * D2R);
  const ddx = Math.sin((fault.strike + 90) * D2R), ddy = Math.cos((fault.strike + 90) * D2R);
  const dem = (x: number, y: number) => 100 + 0.05 * x - 0.03 * y + 3 * Math.sin(x / 55) + 2 * Math.cos(y / 40);

  for (let k = 0; k < count; k++) {
    const i = k % n, j = Math.floor(k / n);
    const x = i * spacing + (rand() - 0.5) * 10;
    const y = j * spacing + (rand() - 0.5) * 10;
    const z0 = dem(x, y);
    const id = `ZK-${k + 1}`;
    const px = x - fault.x, py = y - fault.y;
    const off = ((px * ddx + py * ddy) > 0 && fault.enabled) ? fault.throw : 0;
    const B: number[] = [z0];
    B.push(B[0] - (4 + 2 * rand()));
    B.push(B[1] - (12 + 3 * rand()));
    const shale = Math.max(0, 16 - 0.12 * (x - 40) + (rand() - 0.5) * 2);
    B.push(B[2] - shale);
    B.push(B[3] - (18 + 4 * rand()));
    B.push(B[4] - (25 + 8 * rand()));
    for (let kk = 1; kk < B.length; kk++) B[kk] -= off;
    const depth = B[0] - B[5];
    const st: SurveyStation[] = [];
    let dip = 0.3 + rand() * 1.2, az = rand() * 360;
    for (let md = 0; md <= depth + 1; md += 25) {
      st.push({ holeId: id, md: Math.min(md, depth), dip, azimuth: ((az % 360) + 360) % 360 });
      dip = Math.max(0.1, Math.min(4, dip + (rand() - 0.5) * 0.8));
      az += (rand() - 0.5) * 16;
    }
    proj.surveys.push(...st);
    const collar: Collar = { id, x, y, z: z0, depth };
    const path = computePath(collar, st);
    const mds = B.map(elev => pointAtTvd(path, z0 - elev).md);
    collar.depth = mds[5];
    proj.collars.push(collar);
    for (let kk = 0; kk < 5; kk++) {
      if (mds[kk + 1] - mds[kk] < 0.05) continue;
      proj.lithos.push({ holeId: id, from: +mds[kk].toFixed(2), to: +mds[kk + 1].toFixed(2), litho: params.layerOrder[kk] });
    }
  }
  return proj;
}
