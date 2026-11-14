import { chromium } from 'playwright-core';
import os from 'os';
import path from 'path';

const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:4519/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const status = await page.textContent('#statusbar');
const fps = await page.textContent('#fps-meter');
const issue = await page.textContent('#issue-summary');
console.log('状态栏:', status);
console.log('帧率:', fps);
console.log('校验:', issue);

const gl2 = await page.evaluate(() => {
  const c = document.createElement('canvas');
  return !!c.getContext('webgl2');
});
console.log('WebGL2 可用:', gl2);

const stats = await page.evaluate(() => {
  const app = window.app;
  const v = app.view;
  let meshes = 0, tris = 0;
  v.scene.traverse(o => { if (o.isMesh) { meshes++; const g = o.geometry; if (g.index) tris += g.index.count / 3; } });
  return { meshes, tris: Math.round(tris), holes: app.collars.length };
});
console.log('场景:', JSON.stringify(stats));

await page.screenshot({ path: '/tmp/geo3d-test/shot-main.png' });

await page.click('button[data-tab="section"]');
await page.waitForTimeout(300);
const btns = await page.$$('#section-list button[data-act="show"]');
if (btns.length) { await btns[0].click(); await page.waitForTimeout(800); }
await page.screenshot({ path: '/tmp/geo3d-test/shot-section.png' });

await page.click('button[data-tab="borehole"]');
await page.waitForTimeout(300);
const t0 = Date.now();
await page.evaluate(() => {
  const app = window.app;
  const target = app.lithos.find(l => l.holeId === app.collars[3].id && l.litho === '砂岩');
  if (target) target.to += 6;
  app.model.setData(app.collars, app.surveys, app.lithos);
  const cells = app.model.updateHoles([app.collars[3].id], []);
  app.view.syncGeometryOnly(app.model);
  return cells;
});
console.log('局部重算耗时(ms):', Date.now() - t0);

await page.click('button[data-tab="io"]');
await page.waitForTimeout(200);
await page.click('#btn-stress');
await page.waitForTimeout(3500);
console.log('200孔 状态:', await page.textContent('#statusbar'));
console.log('200孔 帧率:', await page.textContent('#fps-meter'));
await page.mouse.move(750, 450);
await page.mouse.down();
for (let i = 0; i < 30; i++) { await page.mouse.move(750 + i * 8, 450 + i * 2); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(600);
console.log('拖拽后帧率:', await page.textContent('#fps-meter'));
await page.screenshot({ path: '/tmp/geo3d-test/shot-200.png' });

console.log(errors.length ? '页面错误:\n' + errors.join('\n') : '无页面错误');
await browser.close();
