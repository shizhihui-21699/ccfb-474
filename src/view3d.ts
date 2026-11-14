// ============ 三维视图 (Three.js / WebGL2) ============
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoModel, MeshData } from './model';
import { pointAtMd } from './trajectory';
import { SectionDef } from './types';

export interface ViewOptions {
  showVolumes: boolean;
  showSurfaces: boolean;
  showCores: boolean;
  showTraces: boolean;
  showLabels: boolean;
  showFault: boolean;
  showCurtain: boolean;
  opacity: number;
  lightAz: number;   // 光源方位 °
  lightEl: number;   // 光源高度角 °
  lightIntensity: number;
}

export class View3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  world = new THREE.Group();          // 垂向放大挂在这里
  volumesGroup = new THREE.Group();
  surfacesGroup = new THREE.Group();
  coresGroup = new THREE.Group();
  curtainGroup = new THREE.Group();
  faultMesh: THREE.Mesh | null = null;
  ambient = new THREE.AmbientLight(0xffffff, 0.45);
  dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  opts: ViewOptions;
  private canvas: HTMLCanvasElement;
  private labelSprites: THREE.Sprite[] = [];

  constructor(canvas: HTMLCanvasElement, opts: ViewOptions) {
    this.canvas = canvas;
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x10151c);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(this.ambient);
    this.scene.add(this.dirLight);
    this.scene.add(this.dirLight.target);
    this.world.add(this.volumesGroup, this.surfacesGroup, this.coresGroup, this.curtainGroup);
    this.scene.add(this.world);
    this.applyLighting();
  }

  applyLighting() {
    const az = this.opts.lightAz * Math.PI / 180, el = this.opts.lightEl * Math.PI / 180;
    const r = 1000;
    this.dirLight.position.set(
      r * Math.cos(el) * Math.sin(az),
      r * Math.cos(el) * Math.cos(az),
      r * Math.sin(el),
    );
    this.dirLight.intensity = this.opts.lightIntensity;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frameScene(model: GeoModel) {
    const e = model.extent;
    const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2;
    let zMin = Infinity, zMax = -Infinity;
    for (const g of model.grids.flat()) {
      for (const v of g.values) {
        if (Number.isNaN(v)) continue;
        zMin = Math.min(zMin, v); zMax = Math.max(zMax, v);
      }
    }
    if (!isFinite(zMin)) { zMin = 0; zMax = 100; }
    const ve = model.params.vertExagg;
    const cz = (zMin + zMax) / 2 * ve;
    this.controls.target.set(cx, cy, cz);
    const diag = Math.hypot(e.x1 - e.x0, e.y1 - e.y0);
    this.camera.position.set(cx + diag * 0.7, cy - diag * 0.9, cz + diag * 0.8);
    this.camera.near = diag / 500;
    this.camera.far = diag * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private makeGeo(md: MeshData): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
    g.setIndex(new THREE.BufferAttribute(md.indices, 1));
    g.computeVertexNormals();
    return g;
  }

  private syncGroup(group: THREE.Group, meshes: MeshData[], opacity: number, transparent: boolean) {
    const seen = new Set<string>();
    for (const md of meshes) {
      seen.add(md.name);
      let mesh = group.getObjectByName(md.name) as THREE.Mesh | undefined;
      if (mesh) {
        const geo = mesh.geometry;
        const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
        const idx = geo.getIndex();
        if (posAttr && idx && posAttr.count === md.positions.length / 3 && idx.count === md.indices.length) {
          // 结构未变: 原地更新顶点 (局部重算的快速路径)
          (posAttr.array as Float32Array).set(md.positions);
          posAttr.needsUpdate = true;
          geo.computeVertexNormals();
          geo.computeBoundingSphere();
        } else {
          geo.dispose();
          mesh.geometry = this.makeGeo(md);
        }
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.set(md.color);
      } else {
        const mat = new THREE.MeshStandardMaterial({
          color: md.color, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.0,
          transparent, opacity,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        mesh = new THREE.Mesh(this.makeGeo(md), mat);
        mesh.name = md.name;
        group.add(mesh);
      }
    }
    for (const child of [...group.children]) {
      if (!seen.has(child.name)) {
        group.remove(child);
        const m = child as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material)?.dispose();
      }
    }
  }

  /** 全量或局部更新后调用: 重建/同步所有网格 */
  syncModel(model: GeoModel) {
    this.world.scale.z = model.params.vertExagg;
    this.syncGroup(this.volumesGroup, model.buildVolumes(), this.opts.opacity, true);
    this.syncGroup(this.surfacesGroup, model.buildSurfaces(), 1.0, false);
    this.buildCores(model);
    this.buildFaultPlane(model);
    this.applyVisibility();
  }

  /** 仅数据变化 (局部重算后): 只刷新顶点 */
  syncGeometryOnly(model: GeoModel) {
    this.syncGroup(this.volumesGroup, model.buildVolumes(), this.opts.opacity, true);
    this.syncGroup(this.surfacesGroup, model.buildSurfaces(), 1.0, false);
    this.buildCores(model);
  }

  applyVisibility() {
    const o = this.opts;
    this.volumesGroup.visible = o.showVolumes;
    this.surfacesGroup.visible = o.showSurfaces;
    this.coresGroup.visible = o.showCores;
    this.curtainGroup.visible = o.showCurtain;
    if (this.faultMesh) this.faultMesh.visible = o.showFault;
    for (const sp of this.labelSprites) sp.visible = o.showLabels;
    // 透明度
    for (const child of this.volumesGroup.children) {
      const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      m.opacity = o.opacity;
    }
  }

  private buildCores(model: GeoModel) {
    // 清旧
    for (const child of [...this.coresGroup.children]) {
      this.coresGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      if (Array.isArray(m.material)) m.material.forEach(x => x.dispose());
      else (m.material as THREE.Material)?.dispose();
    }
    for (const sp of this.labelSprites) {
      this.world.remove(sp);
      sp.material.map?.dispose(); sp.material.dispose();
    }
    this.labelSprites = [];

    const radius = Math.max(0.8, Math.hypot(model.extent.x1 - model.extent.x0, model.extent.y1 - model.extent.y0) / 400);
    const geos: THREE.BufferGeometry[] = [];
    const tracePts: number[] = [];
    const collarGeos: THREE.BufferGeometry[] = [];
    const tmpColor = new THREE.Color();

    for (const [id, path] of model.paths) {
      const collar = model.collars.get(id)!;
      // 孔迹线
      for (let i = 1; i < path.length; i++) {
        tracePts.push(
          collar.x + path[i - 1].dx, collar.y + path[i - 1].dy, collar.z - path[i - 1].tvd,
          collar.x + path[i].dx, collar.y + path[i].dy, collar.z - path[i].tvd,
        );
      }
      // 岩芯柱: 每个岩性段按 ~6m 细分, 沿真实孔迹摆放圆柱
      for (const l of model.lithos.get(id) ?? []) {
        const color = model.params.colors[l.litho];
        if (!color) continue;
        tmpColor.set(color);
        const len = l.to - l.from;
        const nSeg = Math.max(1, Math.round(len / 6));
        for (let s = 0; s < nSeg; s++) {
          const md1 = l.from + (len * s) / nSeg;
          const md2 = l.from + (len * (s + 1)) / nSeg;
          const p1 = pointAtMd(path, md1), p2 = pointAtMd(path, md2);
          const a = new THREE.Vector3(collar.x + p1.dx, collar.y + p1.dy, collar.z - p1.tvd);
          const b = new THREE.Vector3(collar.x + p2.dx, collar.y + p2.dy, collar.z - p2.tvd);
          const dir = b.clone().sub(a);
          const segLen = dir.length();
          if (segLen < 1e-6) continue;
          const cyl = new THREE.CylinderGeometry(radius, radius, segLen, 8, 1, false);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
          const mid = a.clone().add(b).multiplyScalar(0.5);
          cyl.applyQuaternion(q);
          cyl.translate(mid.x, mid.y, mid.z);
          const nVerts = cyl.getAttribute('position').count;
          const colors = new Float32Array(nVerts * 3);
          for (let v = 0; v < nVerts; v++) {
            colors[v * 3] = tmpColor.r; colors[v * 3 + 1] = tmpColor.g; colors[v * 3 + 2] = tmpColor.b;
          }
          cyl.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          geos.push(cyl);
        }
      }
      // 孔口标记
      const sph = new THREE.SphereGeometry(radius * 1.6, 8, 6);
      sph.translate(collar.x, collar.y, collar.z);
      collarGeos.push(sph);
      // 标签
      const sprite = this.makeLabel(id);
      sprite.position.set(collar.x, collar.y, collar.z + radius * 6);
      this.labelSprites.push(sprite);
      this.world.add(sprite);
      sprite.visible = this.opts.showLabels;
    }

    if (geos.length) {
      const merged = mergeGeometries(geos, false)!;
      geos.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
      mesh.name = 'cores';
      this.coresGroup.add(mesh);
    }
    if (collarGeos.length) {
      const merged = mergeGeometries(collarGeos, false)!;
      collarGeos.forEach(g => g.dispose());
      const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x222831 }));
      mesh.name = 'collars';
      this.coresGroup.add(mesh);
    }
    if (tracePts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tracePts), 3));
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x39424e }));
      line.name = 'traces';
      line.visible = this.opts.showTraces;
      this.coresGroup.add(line);
    }
  }

  private makeLabel(text: string): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(10,14,20,0.65)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(18, 4.5, 1);
    return sp;
  }

  private buildFaultPlane(model: GeoModel) {
    if (this.faultMesh) {
      this.world.remove(this.faultMesh);
      this.faultMesh.geometry.dispose();
      (this.faultMesh.material as THREE.Material).dispose();
      this.faultMesh = null;
    }
    const f = model.params.fault;
    if (!f.enabled) return;
    const e = model.extent;
    const diag = Math.hypot(e.x1 - e.x0, e.y1 - e.y0);
    let zMin = Infinity, zMax = -Infinity;
    for (const g of model.grids.flat()) for (const v of g.values) {
      if (Number.isNaN(v)) continue;
      zMin = Math.min(zMin, v); zMax = Math.max(zMax, v);
    }
    if (!isFinite(zMin)) { zMin = 0; zMax = 100; }
    // 沿迹线的竖直帘幕, 裁剪到模型范围
    const d = model.faultDir();
    // 迹线与网格外接矩形求交
    let tMin = -Infinity, tMax = Infinity;
    for (const [p, dir, lo, hi] of [
      [f.x, d.sx, e.x0, e.x1],
      [f.y, d.sy, e.y0, e.y1],
    ] as const) {
      if (Math.abs(dir) < 1e-9) continue;
      let t1 = (lo - p) / dir, t2 = (hi - p) / dir;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
    }
    if (tMax <= tMin) { tMin = -diag / 2; tMax = diag / 2; }
    const x1 = f.x + d.sx * tMin, y1 = f.y + d.sy * tMin;
    const x2 = f.x + d.sx * tMax, y2 = f.y + d.sy * tMax;
    const zTop = zMax + 5, zBot = zMin - 5;
    const pos = new Float32Array([
      x1, y1, zTop, x2, y2, zTop, x2, y2, zBot,
      x1, y1, zTop, x2, y2, zBot, x1, y1, zBot,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'faultPlane';
    this.faultMesh = mesh;
    this.world.add(mesh);
    mesh.visible = this.opts.showFault;
  }

  /** 更新剖面帘幕 */
  setCurtains(meshes: MeshData[]) {
    this.syncGroup(this.curtainGroup, meshes, 0.95, true);
    this.curtainGroup.visible = this.opts.showCurtain;
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** 比例尺: 返回 {widthPx, label} */
  scaleBar(): { widthPx: number; label: string } {
    const target = this.controls.target;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const p1 = target.clone().project(this.camera);
    const p2 = target.clone().addScaledVector(right, 1).project(this.camera);
    const w = this.canvas.clientWidth || 1;
    const ppm = Math.abs(p2.x - p1.x) / 2 * w; // 每米像素
    if (ppm <= 0 || !isFinite(ppm)) return { widthPx: 0, label: '' };
    const raw = 100 / ppm;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const t = raw / mag;
    const nice = t < 1.5 ? 1 : t < 3.5 ? 2 : t < 7.5 ? 5 : 10;
    const meters = nice * mag;
    return { widthPx: meters * ppm, label: meters >= 1000 ? `${meters / 1000}km` : `${meters}m` };
  }
}
