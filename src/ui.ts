// ============ UI: 面板 / 表格 / 剖面绘制 / 导入导出 ============
import { Collar, SurveyStation, LithoInterval, ModelParams, SectionDef, Project } from './types';
import { GeoModel } from './model';
import { View3D, ViewOptions } from './view3d';
import { validate, ValidationResult } from './validate';
import { cutSection, drawSection2D, buildCurtainMeshes, SectionData } from './section';
import { MeshData } from './model';
import {
  parseCollarCSV, parseSurveyCSV, parseLithoCSV,
  serializeProject, deserializeProject, downloadFile, exportOBJ,
} from './io';
import { generateSample, generateStressTest } from './sample';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $i = (sel: string) => document.querySelector(sel) as HTMLInputElement;
const $s = (sel: string) => document.querySelector(sel) as HTMLSelectElement;

export class App {
  collars: Collar[] = [];
  surveys: SurveyStation[] = [];
  lithos: LithoInterval[] = [];
  params: ModelParams;
  sections: SectionDef[] = [];
  model: GeoModel;
  view: View3D;
  validation: ValidationResult = { issues: [], byHole: new Map() };
  sectionCache = new Map<string, SectionData>();
  activeSection: string | null = null;
  viewOpts: ViewOptions = {
    showVolumes: true, showSurfaces: false, showCores: true, showTraces: false,
    showLabels: true, showFault: true, showCurtain: true,
    opacity: 0.85, lightAz: 135, lightEl: 45, lightIntensity: 1.1,
  };
  private lastApplied = '';
  private activeTable: 'collar' | 'survey' | 'litho' = 'collar';
  private drawing = false;
  private drawPts: { x: number; y: number }[] = [];
  private mousePt: { x: number; y: number } | null = null;
  private autosaveTimer: number | null = null;

  constructor() {
    const proj = generateSample();
    this.collars = proj.collars;
    this.surveys = proj.surveys;
    this.lithos = proj.lithos;
    this.params = proj.params;
    this.sections = proj.sections;
    this.model = new GeoModel(this.params);
    this.view = new View3D($('#gl') as unknown as HTMLCanvasElement, this.viewOpts);
  }

  // ================= 初始化 =================
  init() {
    this.buildTabs();
    this.buildViewToolbar();
    this.renderBoreholePanel();
    this.renderParamsPanel();
    this.renderSectionPanel();
    this.renderIOPanel();
    this.fullRebuild('初始化');
    this.view.frameScene(this.model);
    window.addEventListener('resize', () => this.layoutViewport());
    this.layoutViewport();
    this.bindMapOverlay();
    $('#btn-section-close').onclick = () => {
      $('#section-dock').classList.add('hidden');
      this.activeSection = null;
      this.layoutViewport();
    };
    $('#btn-section-png').onclick = () => this.exportSectionPNG();
  }

  layoutViewport() {
    const vp = $('#viewport');
    const rect = vp.getBoundingClientRect();
    this.view.resize(rect.width, rect.height);
    const dock = $('#section-dock');
    if (!dock.classList.contains('hidden') && this.activeSection) {
      const data = this.sectionCache.get(this.activeSection);
      if (data) drawSection2D($('#section-canvas') as unknown as HTMLCanvasElement, this.model, data);
    }
  }

  setStatus(msg: string) {
    $('#statusbar').textContent = msg;
  }

  // ================= 模型构建 =================
  fullRebuild(reason: string) {
    const t0 = performance.now();
    this.model.setData(this.collars, this.surveys, this.lithos);
    this.model.fullBuild();
    this.view.syncModel(this.model);
    this.refreshValidation();
    this.refreshSections();
    this.renderLegend();
    this.snapshotApplied();
    const dt = performance.now() - t0;
    const warn = this.model.warnings.length ? ` | 警告: ${this.model.warnings.join('; ')}` : '';
    this.setStatus(`${reason}: 全量重建完成, ${this.collars.length} 孔, ${dt.toFixed(0)}ms${warn}`);
    this.scheduleAutosave();
  }

  /** 表格编辑后的增量应用 */
  applyTables() {
    const t0 = performance.now();
    const parsed = this.readTables();
    if (!parsed) return;
    const oldByHole = this.holeSignatureMap(this.collars, this.surveys, this.lithos);
    this.collars = parsed.collars;
    this.surveys = parsed.surveys;
    this.lithos = parsed.lithos;
    const newByHole = this.holeSignatureMap(this.collars, this.surveys, this.lithos);

    const changed: string[] = [];
    const removed: { id: string; pts: (null)[] }[] = [];
    for (const [id, sig] of newByHole) {
      if (oldByHole.get(id) !== sig) changed.push(id);
    }
    for (const id of oldByHole.keys()) {
      if (!newByHole.has(id)) removed.push({ id, pts: [] });
    }

    this.model.setData(this.collars, this.surveys, this.lithos);
    this.refreshValidation();

    const total = Math.max(1, oldByHole.size);
    if (changed.length + removed.length > total * 0.4 || this.model.grids.length === 0) {
      this.fullRebuild('数据变化较大');
      return;
    }
    const result = this.model.updateHoles(changed, removed);
    if (result < 0) {
      // 影响域超出网格等情况, 引擎已退回全量重建
      this.view.syncModel(this.model);
      this.refreshSections();
      this.renderLegend();
      this.snapshotApplied();
      this.setStatus('局部条件不满足, 已全量重建');
      this.scheduleAutosave();
      return;
    }
    this.view.syncGeometryOnly(this.model);
    this.refreshSections();
    this.snapshotApplied();
    const dt = performance.now() - t0;
    this.setStatus(
      `局部重算: 变更 ${changed.length} 孔, 删除 ${removed.length} 孔, ` +
      `重算约 ${result} 个网格节点, 耗时 ${dt.toFixed(1)}ms (未整模重算)`,
    );
    this.scheduleAutosave();
  }

  private holeSignatureMap(c: Collar[], s: SurveyStation[], l: LithoInterval[]): Map<string, string> {
    // 数值统一保留 2 位小数再比较: 表格显示精度有限, 避免显示回读被误判为修改
    const r = (o: object) => JSON.stringify(o, (_, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v);
    const m = new Map<string, string>();
    for (const x of c) m.set(x.id, r(x));
    for (const x of s) m.set(x.holeId, (m.get(x.holeId) ?? '') + r(x));
    for (const x of l) m.set(x.holeId, (m.get(x.holeId) ?? '') + r(x));
    return m;
  }

  private snapshotApplied() {
    this.lastApplied = JSON.stringify([this.collars, this.surveys, this.lithos]);
  }

  private refreshValidation() {
    this.validation = validate(this.collars, this.surveys, this.lithos, this.params);
    this.markTableIssues();
    const n = this.validation.issues.length;
    const el = $('#issue-summary');
    if (el) {
      el.textContent = n === 0 ? '✓ 三张表校验通过, 无对不上的孔' : `⚠ ${n} 处数据问题 (红色行)`;
      el.className = n === 0 ? 'ok' : 'bad';
    }
  }

  private scheduleAutosave() {
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem('geo3d-autosave', serializeProject(this.currentProject()));
      } catch { /* 存储满等情况忽略 */ }
    }, 800);
  }

  currentProject(): Project {
    return { collars: this.collars, surveys: this.surveys, lithos: this.lithos, params: this.params, sections: this.sections };
  }

  loadProject(p: Project, reason: string) {
    this.collars = p.collars;
    this.surveys = p.surveys;
    this.lithos = p.lithos;
    Object.assign(this.params, p.params);
    this.sections = p.sections ?? [];
    this.sectionCache.clear();
    this.activeSection = null;
    $('#section-dock').classList.add('hidden');
    this.renderBoreholePanel();
    this.renderParamsPanel();
    this.renderSectionPanel();
    this.fullRebuild(reason);
    this.view.frameScene(this.model);
  }

  // ================= 页签 =================
  private buildTabs() {
    document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $(`#panel-${btn.dataset.tab}`).classList.add('active');
      };
    });
  }

  // ================= 钻孔管理面板 =================
  renderBoreholePanel() {
    const panel = $('#panel-borehole');
    panel.innerHTML = `
      <div class="sub-tab-bar">
        <button class="sub-tab ${this.activeTable === 'collar' ? 'active' : ''}" data-t="collar">孔口表</button>
        <button class="sub-tab ${this.activeTable === 'survey' ? 'active' : ''}" data-t="survey">测斜表</button>
        <button class="sub-tab ${this.activeTable === 'litho' ? 'active' : ''}" data-t="litho">分层表</button>
      </div>
      <div class="table-actions">
        <button id="btn-add-row">+ 添加行</button>
        <button id="btn-apply-tables" class="primary">应用修改 (局部重算)</button>
      </div>
      <div id="issue-summary"></div>
      <div id="table-container"></div>`;
    panel.querySelectorAll<HTMLButtonElement>('.sub-tab').forEach(b => {
      b.onclick = () => {
        this.activeTable = b.dataset.t as typeof this.activeTable;
        this.renderBoreholePanel();
      };
    });
    $('#btn-add-row').onclick = () => this.addTableRow();
    $('#btn-apply-tables').onclick = () => this.applyTables();
    this.renderTable();
    this.refreshValidation();
  }

  private tableSchema(): { headers: string[]; widths: string } {
    switch (this.activeTable) {
      case 'collar': return { headers: ['孔号', 'X', 'Y', '标高', '孔深', ''], widths: '' };
      case 'survey': return { headers: ['孔号', '测深', '顶角°', '方位角°', ''], widths: '' };
      case 'litho': return { headers: ['孔号', '起始', '终止', '岩性', ''], widths: '' };
    }
  }

  private renderTable() {
    const { headers } = this.tableSchema();
    let rowsHtml = '';
    const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (this.activeTable === 'collar') {
      rowsHtml = this.collars.map((c, i) =>
        `<tr data-row="${i}"><td>${esc(c.id)}</td><td>${c.x.toFixed(2)}</td><td>${c.y.toFixed(2)}</td><td>${c.z.toFixed(2)}</td><td>${c.depth.toFixed(2)}</td><td class="row-del">✕</td></tr>`).join('');
    } else if (this.activeTable === 'survey') {
      rowsHtml = this.surveys.map((s, i) =>
        `<tr data-row="${i}"><td>${esc(s.holeId)}</td><td>${s.md}</td><td>${s.dip}</td><td>${s.azimuth}</td><td class="row-del">✕</td></tr>`).join('');
    } else {
      rowsHtml = this.lithos.map((l, i) =>
        `<tr data-row="${i}"><td>${esc(l.holeId)}</td><td>${l.from}</td><td>${l.to}</td><td>${esc(l.litho)}</td><td class="row-del">✕</td></tr>`).join('');
    }
    $('#table-container').innerHTML =
      `<table class="data-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
      `<tbody id="data-tbody">${rowsHtml}</tbody></table>`;
    const tbody = $('#data-tbody');
    tbody.querySelectorAll<HTMLTableCellElement>('td:not(.row-del)').forEach(td => {
      td.contentEditable = 'true';
    });
    tbody.querySelectorAll<HTMLTableCellElement>('.row-del').forEach(td => {
      td.onclick = () => td.parentElement?.remove();
    });
    this.markTableIssues();
  }

  private markTableIssues() {
    const tbody = document.querySelector('#data-tbody');
    if (!tbody) return;
    tbody.querySelectorAll<HTMLTableRowElement>('tr').forEach(tr => {
      const id = tr.cells[0]?.textContent?.trim() ?? '';
      const issues = this.validation.byHole.get(id);
      tr.classList.toggle('issue', !!issues);
      tr.title = issues ? issues.map(i => i.message).join('\n') : '';
    });
  }

  private addTableRow() {
    const tbody = $('#data-tbody');
    const cols = this.tableSchema().headers.length;
    const tr = document.createElement('tr');
    for (let i = 0; i < cols; i++) {
      const td = document.createElement('td');
      if (i === cols - 1) { td.className = 'row-del'; td.textContent = '✕'; td.onclick = () => tr.remove(); }
      else { td.contentEditable = 'true'; td.textContent = ''; }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    tr.cells[0].focus();
  }

  private readTables(): { collars: Collar[]; surveys: SurveyStation[]; lithos: LithoInterval[] } | null {
    // 当前页签的表先从 DOM 读; 其余两个用内存状态
    const num = (s: string) => parseFloat(s);
    const result = {
      collars: this.activeTable === 'collar' ? [] as Collar[] : this.collars,
      surveys: this.activeTable === 'survey' ? [] as SurveyStation[] : this.surveys,
      lithos: this.activeTable === 'litho' ? [] as LithoInterval[] : this.lithos,
    };
    const rows = [...document.querySelectorAll<HTMLTableRowElement>('#data-tbody tr')];
    for (const tr of rows) {
      const t = [...tr.cells].map(c => c.textContent?.trim() ?? '');
      try {
        if (this.activeTable === 'collar') {
          (result.collars as Collar[]).push({ id: t[0], x: num(t[1]), y: num(t[2]), z: num(t[3]), depth: num(t[4]) });
        } else if (this.activeTable === 'survey') {
          (result.surveys as SurveyStation[]).push({ holeId: t[0], md: num(t[1]), dip: num(t[2]), azimuth: num(t[3]) });
        } else {
          (result.lithos as LithoInterval[]).push({ holeId: t[0], from: num(t[1]), to: num(t[2]), litho: t[3] });
        }
      } catch {
        this.setStatus('表格解析失败, 请检查非数字内容');
        return null;
      }
    }
    return result;
  }

  // ================= 参数面板 =================
  renderParamsPanel() {
    const p = this.params;
    const panel = $('#panel-params');
    const layerRows = p.layerOrder.map((l, i) => `
      <div class="layer-row">
        <span class="layer-idx">${i + 1}</span>
        <input class="layer-name" value="${l}" data-idx="${i}" />
        <input type="color" class="layer-color" value="${p.colors[l] ?? '#999999'}" data-idx="${i}" />
        ${i < p.layerOrder.length - 1 ? '<span class="layer-arrow">↓</span>' : ''}
      </div>`).join('');
    panel.innerHTML = `
      <div class="form-section"><h3>网格与插值</h3>
        <label>网格 X 节点数 <input id="p-nx" type="number" value="${p.gridNx}" min="10" max="300"></label>
        <label>网格 Y 节点数 <input id="p-ny" type="number" value="${p.gridNy}" min="10" max="300"></label>
        <label>垂向放大 <input id="p-ve" type="number" step="0.1" value="${p.vertExagg}" min="0.1" max="20"></label>
        <label>插值方法
          <select id="p-method">
            <option value="kriging" ${p.interp.method === 'kriging' ? 'selected' : ''}>克里金 (普通克里金)</option>
            <option value="idw" ${p.interp.method === 'idw' ? 'selected' : ''}>反距离加权 (IDW)</option>
          </select>
        </label>
        <label>IDW 幂次 <input id="p-power" type="number" step="0.5" value="${p.interp.power}"></label>
        <label>影响半径 m <input id="p-radius" type="number" value="${p.interp.radius}"></label>
        <label>最大邻近样本 <input id="p-maxn" type="number" value="${p.interp.maxNeighbors}"></label>
      </div>
      <div class="form-section"><h3>变差函数 (克里金)</h3>
        <label>模型
          <select id="p-vmodel">
            <option value="spherical" ${p.interp.variogram.model === 'spherical' ? 'selected' : ''}>球状</option>
            <option value="exponential" ${p.interp.variogram.model === 'exponential' ? 'selected' : ''}>指数</option>
            <option value="gaussian" ${p.interp.variogram.model === 'gaussian' ? 'selected' : ''}>高斯</option>
          </select>
        </label>
        <label>块金值 <input id="p-nugget" type="number" step="0.1" value="${p.interp.variogram.nugget}"></label>
        <label>基台值 <input id="p-sill" type="number" step="0.5" value="${p.interp.variogram.sill}"></label>
        <label>变程 m <input id="p-range" type="number" value="${p.interp.variogram.range}"></label>
      </div>
      <div class="form-section"><h3>断层 (正断层)</h3>
        <label><input id="p-fault-on" type="checkbox" ${p.fault.enabled ? 'checked' : ''}> 启用断层</label>
        <label>走向方位角° <input id="p-fstrike" type="number" value="${p.fault.strike}"></label>
        <label>倾角° <input id="p-fdip" type="number" value="${p.fault.dip}"></label>
        <label>迹线点 X <input id="p-fx" type="number" value="${p.fault.x}"></label>
        <label>迹线点 Y <input id="p-fy" type="number" value="${p.fault.y}"></label>
        <label>铅直断距 m <input id="p-fthrow" type="number" value="${p.fault.throw}"></label>
      </div>
      <div class="form-section"><h3>地层表 (自上而下)</h3>
        <div id="layer-list">${layerRows}</div>
        <div class="row-btns">
          <button id="btn-add-layer">+ 添加地层</button>
          <button id="btn-del-layer">- 移除末层</button>
        </div>
      </div>
      <div class="form-section"><h3>显示</h3>
        <label>地质体透明度 <input id="p-opacity" type="range" min="0.1" max="1" step="0.05" value="${this.viewOpts.opacity}"></label>
        <label>光照方位° <input id="p-laz" type="range" min="0" max="360" value="${this.viewOpts.lightAz}"></label>
        <label>光照高度° <input id="p-lel" type="range" min="5" max="90" value="${this.viewOpts.lightEl}"></label>
        <label>光照强度 <input id="p-lint" type="range" min="0.2" max="2.5" step="0.1" value="${this.viewOpts.lightIntensity}"></label>
      </div>
      <button id="btn-apply-params" class="primary wide">应用参数并重建模型</button>`;

    // 显示类参数即时生效
    $('#p-opacity').oninput = e => {
      this.viewOpts.opacity = parseFloat((e.target as HTMLInputElement).value);
      this.view.applyVisibility();
    };
    const lightUpdate = () => {
      this.viewOpts.lightAz = parseFloat($i('#p-laz').value);
      this.viewOpts.lightEl = parseFloat($i('#p-lel').value);
      this.viewOpts.lightIntensity = parseFloat($i('#p-lint').value);
      this.view.applyLighting();
    };
    $('#p-laz').oninput = lightUpdate;
    $('#p-lel').oninput = lightUpdate;
    $('#p-lint').oninput = lightUpdate;
    $('#p-ve').onchange = () => {
      this.params.vertExagg = parseFloat($i('#p-ve').value) || 1;
      this.view.syncModel(this.model);
    };

    $('#btn-add-layer').onclick = () => {
      const name = `新地层${this.params.layerOrder.length + 1}`;
      this.params.layerOrder.push(name);
      this.params.colors[name] = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      this.renderParamsPanel();
    };
    $('#btn-del-layer').onclick = () => {
      if (this.params.layerOrder.length > 1) this.params.layerOrder.pop();
      this.renderParamsPanel();
    };

    $('#btn-apply-params').onclick = () => {
      const v = (id: string) => parseFloat($i(id).value);
      this.params.gridNx = Math.round(v('#p-nx')) || 70;
      this.params.gridNy = Math.round(v('#p-ny')) || 70;
      this.params.vertExagg = v('#p-ve') || 1;
      this.params.interp.method = $s('#p-method').value as 'idw' | 'kriging';
      this.params.interp.power = v('#p-power') || 2;
      this.params.interp.radius = v('#p-radius') || 100;
      this.params.interp.maxNeighbors = Math.round(v('#p-maxn')) || 12;
      this.params.interp.variogram.model = $s('#p-vmodel').value as 'spherical';
      this.params.interp.variogram.nugget = v('#p-nugget') || 0;
      this.params.interp.variogram.sill = v('#p-sill') || 1;
      this.params.interp.variogram.range = v('#p-range') || 100;
      this.params.fault.enabled = $i('#p-fault-on').checked;
      this.params.fault.strike = v('#p-fstrike') || 0;
      this.params.fault.dip = v('#p-fdip') || 90;
      this.params.fault.x = v('#p-fx') || 0;
      this.params.fault.y = v('#p-fy') || 0;
      this.params.fault.throw = v('#p-fthrow') || 0;
      // 地层表
      const names: string[] = [];
      document.querySelectorAll<HTMLInputElement>('.layer-name').forEach(inp => {
        if (inp.value.trim()) names.push(inp.value.trim());
      });
      document.querySelectorAll<HTMLInputElement>('.layer-color').forEach(inp => {
        const idx = parseInt(inp.dataset.idx ?? '0');
        const name = names[idx];
        if (name) {
          // 颜色跟着新名字走
          const oldName = this.params.layerOrder[idx];
          if (this.params.colors[oldName] === undefined || oldName !== name) {
            this.params.colors[name] = inp.value;
          } else {
            this.params.colors[name] = inp.value;
          }
        }
      });
      if (names.length > 0) this.params.layerOrder = names;
      this.fullRebuild('参数更新');
    };
  }

  // ================= 视图工具条 =================
  private buildViewToolbar() {
    const tb = $('#view-toolbar');
    const items: [keyof ViewOptions, string][] = [
      ['showVolumes', '地质体'], ['showSurfaces', '界面'], ['showCores', '岩芯柱'],
      ['showTraces', '孔迹'], ['showLabels', '标签'], ['showFault', '断层'], ['showCurtain', '剖面帘幕'],
    ];
    tb.innerHTML = items.map(([k, label]) =>
      `<label class="tg"><input type="checkbox" data-k="${k}" ${this.viewOpts[k] ? 'checked' : ''}>${label}</label>`).join('') +
      '<button id="btn-reset-view">复位视角</button>';
    tb.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(cb => {
      cb.onchange = () => {
        const k = cb.dataset.k as keyof ViewOptions;
        (this.viewOpts[k] as boolean) = cb.checked;
        this.view.applyVisibility();
      };
    });
    $('#btn-reset-view').onclick = () => this.view.frameScene(this.model);
  }

  // ================= 剖面 =================
  renderSectionPanel() {
    const panel = $('#panel-section');
    const list = this.sections.map((s, i) => `
      <div class="section-item">
        <span>${s.name} (${s.pts.length} 个拐点)</span>
        <button data-act="show" data-i="${i}">查看</button>
        <button data-act="del" data-i="${i}">删除</button>
      </div>`).join('');
    panel.innerHTML = `
      <p class="hint">在俯视图上点击画折线, 双击或回车结束, Esc 取消。剖面在三维中同步显示为帘幕。</p>
      <button id="btn-draw-section" class="primary wide">✏️ 绘制新剖面</button>
      <div id="section-list">${list || '<p class="hint">暂无剖面</p>'}</div>`;
    $('#btn-draw-section').onclick = () => this.startDrawSection();
    panel.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach(btn => {
      const i = parseInt(btn.dataset.i!);
      btn.onclick = () => {
        if (btn.dataset.act === 'show') this.showSection(this.sections[i].name);
        else {
          this.sections.splice(i, 1);
          this.sectionCache.clear();
          this.refreshSections();
          this.renderSectionPanel();
        }
      };
    });
  }

  private refreshSections() {
    this.sectionCache.clear();
    const curtains: MeshData[] = [];
    for (const def of this.sections) {
      const data = cutSection(this.model, def);
      this.sectionCache.set(def.name, data);
      curtains.push(...buildCurtainMeshes(this.model, data));
    }
    this.view.setCurtains(curtains);
    if (this.activeSection && this.sectionCache.has(this.activeSection)) {
      drawSection2D($('#section-canvas') as unknown as HTMLCanvasElement, this.model, this.sectionCache.get(this.activeSection)!);
    }
  }

  showSection(name: string) {
    this.activeSection = name;
    $('#section-dock').classList.remove('hidden');
    $('#section-dock-title').textContent = `剖面: ${name}`;
    this.layoutViewport();
    const data = this.sectionCache.get(name);
    if (data) drawSection2D($('#section-canvas') as unknown as HTMLCanvasElement, this.model, data);
  }

  private exportSectionPNG() {
    if (!this.activeSection) return;
    const canvas = $('#section-canvas') as unknown as HTMLCanvasElement;
    canvas.toBlob(blob => {
      if (blob) downloadFile(`${this.activeSection}.png`, blob);
    }, 'image/png');
  }

  // ---------- 俯视图绘制 ----------
  private bindMapOverlay() {
    const ov = $('#map-overlay') as unknown as HTMLCanvasElement;
    ov.addEventListener('click', e => {
      if (!this.drawing) return;
      const p = this.overlayToWorld(e);
      if (p) { this.drawPts.push(p); this.redrawOverlay(); }
    });
    ov.addEventListener('dblclick', e => {
      if (!this.drawing) return;
      e.preventDefault();
      this.finishDrawSection();
    });
    ov.addEventListener('mousemove', e => {
      if (!this.drawing) return;
      this.mousePt = this.overlayToWorld(e);
      this.redrawOverlay();
    });
    window.addEventListener('keydown', e => {
      if (!this.drawing) return;
      if (e.key === 'Escape') this.cancelDraw();
      if (e.key === 'Enter') this.finishDrawSection();
    });
  }

  private overlayTransform() {
    const ov = $('#map-overlay') as unknown as HTMLCanvasElement;
    const e = this.model.extent;
    const pad = 40;
    const w = ov.clientWidth - pad * 2, h = ov.clientHeight - pad * 2;
    const s = Math.min(w / (e.x1 - e.x0), h / (e.y1 - e.y0));
    return {
      s, pad,
      toPx: (x: number, y: number) => ({
        px: pad + (x - e.x0) * s + (w - (e.x1 - e.x0) * s) / 2,
        py: ov.clientHeight - (pad + (y - e.y0) * s + (h - (e.y1 - e.y0) * s) / 2),
      }),
      toWorld: (px: number, py: number) => ({
        x: e.x0 + (px - pad - (w - (e.x1 - e.x0) * s) / 2) / s,
        y: e.y0 + (ov.clientHeight - py - pad - (h - (e.y1 - e.y0) * s) / 2) / s,
      }),
    };
  }

  private overlayToWorld(e: MouseEvent): { x: number; y: number } | null {
    const ov = $('#map-overlay') as unknown as HTMLCanvasElement;
    const rect = ov.getBoundingClientRect();
    const t = this.overlayTransform();
    return t.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  private startDrawSection() {
    this.drawing = true;
    this.drawPts = [];
    const ov = $('#map-overlay');
    ov.classList.remove('hidden');
    this.setStatus('绘制剖面: 单击加点, 双击/回车结束, Esc 取消');
    this.redrawOverlay();
  }

  private cancelDraw() {
    this.drawing = false;
    $('#map-overlay').classList.add('hidden');
    this.setStatus('已取消绘制');
  }

  private finishDrawSection() {
    if (this.drawPts.length < 2) { this.cancelDraw(); return; }
    this.drawing = false;
    $('#map-overlay').classList.add('hidden');
    const name = `剖面${this.sections.length + 1}`;
    this.sections.push({ name, pts: this.drawPts.slice(), corridor: 20 });
    this.refreshSections();
    this.renderSectionPanel();
    this.showSection(name);
    this.setStatus(`已创建 ${name}, ${this.drawPts.length} 个拐点`);
    this.scheduleAutosave();
  }

  private redrawOverlay() {
    const ov = $('#map-overlay') as unknown as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    ov.width = ov.clientWidth * dpr;
    ov.height = ov.clientHeight * dpr;
    const ctx = ov.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(12,16,22,0.88)';
    ctx.fillRect(0, 0, ov.clientWidth, ov.clientHeight);
    const t = this.overlayTransform();

    // 断层线
    if (this.params.fault.enabled) {
      const f = this.params.fault;
      const d = this.model.faultDir();
      const L = 1000;
      const a = t.toPx(f.x - d.sx * L, f.y - d.sy * L);
      const b = t.toPx(f.x + d.sx * L, f.y + d.sy * L);
      ctx.strokeStyle = '#ff5555';
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff5555';
      ctx.font = '12px sans-serif';
      ctx.fillText('断层迹线', b.px - 70, b.py - 6);
    }
    // 钻孔
    for (const c of this.collars) {
      const p = t.toPx(c.x, c.y);
      ctx.fillStyle = '#7ec8ff';
      ctx.beginPath(); ctx.arc(p.px, p.py, 3, 0, Math.PI * 2); ctx.fill();
    }
    // 已有剖面
    ctx.strokeStyle = '#5aa9e6';
    ctx.lineWidth = 2;
    for (const s of this.sections) {
      ctx.beginPath();
      s.pts.forEach((pt, i) => {
        const p = t.toPx(pt.x, pt.y);
        if (i === 0) ctx.moveTo(p.px, p.py); else ctx.lineTo(p.px, p.py);
      });
      ctx.stroke();
    }
    // 当前折线
    if (this.drawPts.length) {
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      const pts = this.mousePt ? [...this.drawPts, this.mousePt] : this.drawPts;
      pts.forEach((pt, i) => {
        const p = t.toPx(pt.x, pt.y);
        if (i === 0) ctx.moveTo(p.px, p.py); else ctx.lineTo(p.px, p.py);
      });
      ctx.stroke();
      for (const pt of this.drawPts) {
        const p = t.toPx(pt.x, pt.y);
        ctx.fillStyle = '#ffd54f';
        ctx.beginPath(); ctx.arc(p.px, p.py, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = '#e6ebf2';
    ctx.font = '13px sans-serif';
    ctx.fillText('单击加点 · 双击/回车结束 · Esc 取消', 14, 22);
  }

  // ================= 图例 =================
  renderLegend() {
    const el = $('#legend');
    const rows = this.params.layerOrder.map(l =>
      `<div class="legend-row"><span class="swatch" style="background:${this.params.colors[l] ?? '#999'}"></span>${l}</div>`).join('');
    el.innerHTML = `<div class="legend-title">图例</div>${rows}` +
      (this.params.fault.enabled ? `<div class="legend-row"><span class="swatch fault"></span>正断层 (断距 ${this.params.fault.throw}m)</div>` : '');
  }

  // ================= 数据/导出面板 =================
  renderIOPanel() {
    const panel = $('#panel-io');
    panel.innerHTML = `
      <div class="form-section"><h3>导入三张表 (CSV, 支持中/英文表头)</h3>
        <label>孔口表 <input type="file" id="imp-collar" accept=".csv,.txt"></label>
        <label>测斜表 <input type="file" id="imp-survey" accept=".csv,.txt"></label>
        <label>分层表 <input type="file" id="imp-litho" accept=".csv,.txt"></label>
        <div id="import-msg" class="hint"></div>
      </div>
      <div class="form-section"><h3>导出</h3>
        <button id="btn-export-obj" class="wide">导出模型 OBJ (+MTL)</button>
        <button id="btn-export-csv" class="wide">导出当前三张表 CSV</button>
      </div>
      <div class="form-section"><h3>工程</h3>
        <button id="btn-save-proj" class="wide">保存工程 (.geo3d.json)</button>
        <label class="file-label">打开工程 <input type="file" id="inp-open-proj" accept=".json"></label>
        <button id="btn-restore" class="wide">恢复上次会话 (浏览器本地)</button>
      </div>
      <div class="form-section"><h3>数据</h3>
        <button id="btn-sample" class="wide">加载示例数据 (36 孔, 尖灭+正断层)</button>
        <button id="btn-stress" class="wide">生成 200 孔压力测试</button>
      </div>`;

    const readFile = (input: HTMLInputElement, cb: (text: string) => void) => {
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => cb(String(reader.result));
        reader.readAsText(f);
      };
    };
    const msg = (m: string) => { $('#import-msg').textContent = m; };

    readFile($('#imp-collar') as unknown as HTMLInputElement, text => {
      const r = parseCollarCSV(text);
      if (r.rows.length) { this.collars = r.rows; this.fullRebuild(`导入孔口表 ${r.rows.length} 孔`); this.renderBoreholePanel(); }
      msg(r.errors.length ? '孔口表: ' + r.errors.slice(0, 3).join('; ') : `孔口表导入成功: ${r.rows.length} 行`);
    });
    readFile($('#imp-survey') as unknown as HTMLInputElement, text => {
      const r = parseSurveyCSV(text);
      if (r.rows.length) { this.surveys = r.rows; this.fullRebuild(`导入测斜表 ${r.rows.length} 行`); this.renderBoreholePanel(); }
      msg(r.errors.length ? '测斜表: ' + r.errors.slice(0, 3).join('; ') : `测斜表导入成功: ${r.rows.length} 行`);
    });
    readFile($('#imp-litho') as unknown as HTMLInputElement, text => {
      const r = parseLithoCSV(text);
      if (r.rows.length) { this.lithos = r.rows; this.fullRebuild(`导入分层表 ${r.rows.length} 行`); this.renderBoreholePanel(); }
      msg(r.errors.length ? '分层表: ' + r.errors.slice(0, 3).join('; ') : `分层表导入成功: ${r.rows.length} 行`);
    });

    $('#btn-export-obj').onclick = () => {
      const meshes = [...this.model.buildVolumes(), ...this.model.buildSurfaces()];
      const { obj, mtl } = exportOBJ(meshes);
      downloadFile('model.obj', obj);
      downloadFile('model.mtl', mtl);
      this.setStatus(`OBJ 导出完成: ${meshes.length} 个对象`);
    };
    $('#btn-export-csv').onclick = () => {
      const c = ['孔号,X,Y,标高,孔深', ...this.collars.map(x => `${x.id},${x.x},${x.y},${x.z},${x.depth}`)].join('\n');
      const s = ['孔号,测深,顶角,方位角', ...this.surveys.map(x => `${x.holeId},${x.md},${x.dip},${x.azimuth}`)].join('\n');
      const l = ['孔号,起始深度,终止深度,岩性', ...this.lithos.map(x => `${x.holeId},${x.from},${x.to},${x.litho}`)].join('\n');
      downloadFile('collar.csv', c, 'text/csv');
      downloadFile('survey.csv', s, 'text/csv');
      downloadFile('litho.csv', l, 'text/csv');
    };
    $('#btn-save-proj').onclick = () => {
      downloadFile('project.geo3d.json', serializeProject(this.currentProject()), 'application/json');
      this.setStatus('工程已保存');
    };
    ($('#inp-open-proj') as unknown as HTMLInputElement).onchange = e => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          this.loadProject(deserializeProject(String(reader.result)), '打开工程');
        } catch (err) {
          this.setStatus('工程文件打开失败: ' + (err as Error).message);
        }
      };
      reader.readAsText(f);
    };
    $('#btn-restore').onclick = () => {
      const text = localStorage.getItem('geo3d-autosave');
      if (!text) { this.setStatus('没有可恢复的会话'); return; }
      try {
        this.loadProject(deserializeProject(text), '恢复上次会话');
      } catch { this.setStatus('恢复失败'); }
    };
    $('#btn-sample').onclick = () => {
      const p = generateSample();
      this.loadProject(p, '加载示例数据');
    };
    $('#btn-stress').onclick = () => {
      const t0 = performance.now();
      const p = generateStressTest(200);
      this.loadProject(p, '200 孔压力测试');
      this.setStatus(`200 孔压力测试: 数据生成+建模共 ${(performance.now() - t0).toFixed(0)}ms, 观察右上角帧率`);
    };
  }
}
