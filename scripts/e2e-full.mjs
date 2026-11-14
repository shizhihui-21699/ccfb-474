import { chromium } from 'playwright-core';
import os from 'os';
import path from 'path';
import fs from 'fs';

const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
let failed = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

await page.goto('http://localhost:4519/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// ---- 1. 表格编辑 -> 局部重算 ----
console.log('== 表格编辑局部重算 ==');
await page.click('button[data-tab="borehole"]');
await page.waitForTimeout(200);
// 修改孔口表 ZK-1 的标高
const cell = await page.$('#data-tbody tr:first-child td:nth-child(4)');
await cell.click();
await page.keyboard.press('ControlOrMeta+a');
await page.keyboard.type('120.00');
await page.click('#btn-apply-tables');
await page.waitForTimeout(400);
const st1 = await page.textContent('#statusbar');
console.log('  状态:', st1);
check('局部重算而非全量', st1.includes('局部重算'));

// ---- 2. 导入带错误的 CSV -> 标红 ----
console.log('== 校验标记 ==');
await page.click('button[data-tab="io"]');
await page.waitForTimeout(200);
const badCSV = '孔号,测深,顶角,方位角\nZK-1,10,1.2,90\nZK-999,20,2.0,180\n';
const [fc] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('#imp-survey'),
]);
await fc.setFiles({ name: 'survey.csv', mimeType: 'text/csv', buffer: Buffer.from(badCSV) });
await page.waitForTimeout(800);
const issue = await page.textContent('#issue-summary');
console.log('  校验:', issue);
check('对不上的孔被标出', issue.includes('数据问题'));
const redRows = await page.$$eval('#table-container tr.issue', els => els.length);
// 当前在测斜表? 切过去看
await page.click('button[data-tab="borehole"]');
await page.waitForTimeout(200);
await page.click('.sub-tab[data-t="survey"]');
await page.waitForTimeout(200);
const redSurvey = await page.$$eval('#table-container tr.issue', els => els.length);
check('测斜表有标红行', redSurvey >= 1);
const tooltip = await page.$eval('#table-container tr.issue', el => el.title);
console.log('  标红提示:', tooltip);
check('提示信息正确', tooltip.includes('ZK-999'));

// ---- 3. 画新剖面 ----
console.log('== 绘制剖面 ==');
await page.click('button[data-tab="section"]');
await page.waitForTimeout(200);
await page.click('#btn-draw-section');
await page.waitForTimeout(300);
const overlay = await page.$('#map-overlay');
check('俯视图已打开', !!(await overlay.isVisible()));
const box = await overlay.boundingBox();
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.mouse.dblclick(box.x + box.width * 0.7, box.y + box.height * 0.4);
await page.waitForTimeout(600);
const dockVisible = await page.$eval('#section-dock', el => !el.classList.contains('hidden'));
check('剖面停靠窗已打开', dockVisible);
const secTitle = await page.textContent('#section-dock-title');
console.log('  ', secTitle);
const curtains = await page.evaluate(() => window.app.view.curtainGroup.children.length);
check('三维帘幕已生成', curtains >= 10); // 2 条剖面 × 5 层
await page.screenshot({ path: '/tmp/geo3d-test/shot-newsection.png' });

// ---- 4. 导出 ----
console.log('== 导出 ==');
await page.click('button[data-tab="io"]');
await page.waitForTimeout(200);
const dl = [];
page.on('download', d => dl.push(d.suggestedFilename()));
await page.click('#btn-export-obj');
await page.waitForTimeout(800);
check('OBJ+MTL 已下载', dl.includes('model.obj') && dl.includes('model.mtl'));
await page.click('#btn-save-proj');
await page.waitForTimeout(500);
check('工程已下载', dl.some(f => f.endsWith('.geo3d.json')));

// 剖面 PNG
await page.click('button[data-tab="section"]');
await page.waitForTimeout(200);
const showBtns = await page.$$('#section-list button[data-act="show"]');
await showBtns[0].click();
await page.waitForTimeout(400);
await page.click('#btn-section-png');
await page.waitForTimeout(500);
check('剖面 PNG 已下载', dl.some(f => f.endsWith('.png')));

// ---- 5. 工程打开 (用刚保存的工程回传) ----
console.log('== 工程保存/打开 ==');
const projJson = await page.evaluate(() => {
  const app = window.app;
  return JSON.stringify({ format: 'geo3d-project', version: 1, collars: app.collars, surveys: app.surveys, lithos: app.lithos, params: app.params, sections: app.sections });
});
const tmpProj = '/tmp/geo3d-test/test.geo3d.json';
fs.writeFileSync(tmpProj, projJson);
// 先改成 200 孔, 再打开工程应恢复 36 孔
await page.click('button[data-tab="io"]');
await page.waitForTimeout(200);
await page.click('#btn-stress');
await page.waitForTimeout(2500);
const [fc2] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('label:has(#inp-open-proj)'),
]);
await fc2.setFiles(tmpProj);
await page.waitForTimeout(1500);
const holes = await page.evaluate(() => window.app.collars.length);
check('工程打开后恢复 36 孔', holes === 36);

// ---- 6. 界面开关 ----
await page.click('input[data-k="showSurfaces"]');
await page.waitForTimeout(400);
const surfVisible = await page.evaluate(() => window.app.view.surfacesGroup.visible);
check('界面显示开关生效', surfVisible === true);
await page.screenshot({ path: '/tmp/geo3d-test/shot-surfaces.png' });

console.log(errors.length ? '页面错误:\n' + [...new Set(errors)].slice(0, 5).join('\n') : '无页面错误');
console.log(failed === 0 ? 'E2E 全部通过' : `${failed} 项失败`);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
