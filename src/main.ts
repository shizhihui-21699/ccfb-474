// ============ 入口 ============
import { App } from './ui';

const app = new App();
app.init();

// 渲染循环 + 帧率表 + 比例尺
const fpsEl = document.getElementById('fps-meter')!;
const sbLine = document.getElementById('scalebar-line')!;
const sbLabel = document.getElementById('scalebar-label')!;
let frames = 0;
let lastFpsT = performance.now();
let fps = 0;

function loop() {
  requestAnimationFrame(loop);
  app.view.render();
  frames++;
  const now = performance.now();
  if (now - lastFpsT >= 500) {
    fps = frames * 1000 / (now - lastFpsT);
    frames = 0;
    lastFpsT = now;
    fpsEl.textContent = `${fps.toFixed(0)} fps`;
    fpsEl.style.color = fps >= 50 ? '#7ee787' : fps >= 30 ? '#ffd54f' : '#ff5555';
    // 比例尺
    const sb = app.view.scaleBar();
    if (sb.widthPx > 0) {
      sbLine.style.width = `${sb.widthPx}px`;
      sbLabel.textContent = sb.label;
    }
  }
}
loop();

// 调试挂全局
(window as unknown as { app: App }).app = app;
