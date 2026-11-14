import { chromium } from 'playwright-core';
import os from 'os';
import path from 'path';

const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto('http://localhost:4519/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const bad = await page.evaluate(() => {
  const app = window.app;
  const out = [];
  app.view.scene.traverse(o => {
    if (!o.isMesh && !o.isLineSegments && !o.isLine) return;
    const pos = o.geometry?.getAttribute?.('position');
    if (!pos) return;
    let nan = 0;
    for (let i = 0; i < pos.array.length; i++) if (Number.isNaN(pos.array[i])) nan++;
    if (nan > 0) out.push(`${o.name || o.type} (parent=${o.parent?.name || o.parent?.type}): ${nan}/${pos.array.length} NaN`);
  });
  return out;
});
console.log(bad.join('\n') || 'no NaN found');
await browser.close();
