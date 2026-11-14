// ============ 数据类型定义 ============

/** 孔口表 */
export interface Collar {
  id: string;      // 孔号
  x: number;       // 孔口 X (东)
  y: number;       // 孔口 Y (北)
  z: number;       // 孔口标高
  depth: number;   // 孔深 (终孔深度, 沿孔迹)
}

/** 测斜表: dip = 顶角(与铅垂线夹角, 度), azimuth = 方位角(度, 北为0顺时针) */
export interface SurveyStation {
  holeId: string;
  md: number;       // 测深(沿孔迹)
  dip: number;      // 顶角 °
  azimuth: number;  // 方位角 °
}

/** 分层表 */
export interface LithoInterval {
  holeId: string;
  from: number;   // 起始深度 (沿孔迹)
  to: number;     // 终止深度
  litho: string;  // 岩性名称
}

export type TableName = 'collar' | 'survey' | 'litho';

export interface Issue {
  table: TableName;
  holeId: string;
  row: number;
  message: string;
}

export interface VariogramParams {
  model: 'spherical' | 'exponential' | 'gaussian';
  nugget: number;   // 块金值
  sill: number;     // 基台值
  range: number;    // 变程 (m)
}

export interface InterpParams {
  method: 'idw' | 'kriging';
  power: number;        // IDW 幂次
  radius: number;       // 影响半径 (m)
  maxNeighbors: number; // 最大邻近样本数
  variogram: VariogramParams;
}

export interface FaultParams {
  enabled: boolean;
  strike: number;   // 走向方位角 °
  dip: number;      // 倾角 ° (仅用于展示)
  x: number;        // 断层迹线上一点
  y: number;
  throw: number;    // 铅直断距 (m), 倾向侧下降 (正断层)
}

export interface ModelParams {
  gridNx: number;
  gridNy: number;
  margin: number;        // 网格外扩 (m)
  vertExagg: number;     // 垂向放大倍数
  layerOrder: string[];              // 地层顺序(自上而下), 值为岩性名
  colors: Record<string, string>;    // 岩性 -> 颜色
  fault: FaultParams;
  interp: InterpParams;
}

export interface SectionDef {
  name: string;
  pts: { x: number; y: number }[];
  corridor: number; // 投影走廊宽度 (m)
}

export interface Project {
  collars: Collar[];
  surveys: SurveyStation[];
  lithos: LithoInterval[];
  params: ModelParams;
  sections: SectionDef[];
}

export function defaultParams(): ModelParams {
  return {
    gridNx: 70,
    gridNy: 70,
    margin: 15,
    vertExagg: 1.5,
    layerOrder: ['覆盖层', '砂岩', '页岩', '灰岩', '花岗岩'],
    colors: {
      '覆盖层': '#c8b560',
      '砂岩': '#e8c468',
      '页岩': '#7a9e7e',
      '灰岩': '#6fa8dc',
      '花岗岩': '#b08dad',
    },
    fault: { enabled: true, strike: 25, dip: 70, x: 100, y: 90, throw: 12 },
    interp: {
      method: 'kriging',
      power: 2,
      radius: 120,
      maxNeighbors: 12,
      variogram: { model: 'spherical', nugget: 0.5, sill: 30, range: 110 },
    },
  };
}
