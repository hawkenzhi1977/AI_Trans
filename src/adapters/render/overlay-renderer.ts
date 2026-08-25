import type { RenderableCue } from '../../domain/ports/subtitle-renderer';
import type { SubtitleRenderer } from '../../domain/ports/subtitle-renderer';
import type { Millis } from '../../domain/models/subtitle';
import { diagLog } from '../../infrastructure/debug-log';

/**
 * 覆蓋層字幕渲染器——注入播放器容器上方的透明層。
 * 支持單語/雙語、provisional 原地更新、rAF 對齊播放時間。
 */
const NO_CUE_LOG_INTERVAL_MS = 5_000;

export class OverlayRenderer implements SubtitleRenderer {
  private root: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private style: Record<string, string> = {};
  private cues: RenderableCue[] = [];
  private currentId: string | null = null;
  // 日誌降壓欄位：避免每幀列印日誌造成控制台洪水洪災
  private lastLoggedCueCount = -1;
  private lastLoggedActiveId: string | null = null;
  private lastNoCueLogTime = 0;

  mount(container: HTMLElement, style: Record<string, string> = {}): void {
    diagLog('overlay', 'mount() called, container:', container.tagName, container.className);
    this.style = style;

    // 注入 class 樣式：原文縮小+半透明，譯文正常顯示
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .ai-trans-src {
        font-size: 0.75em;
        opacity: 0.7;
        display: block;
        margin-bottom: 0.2em;
      }
      .ai-trans-dst {
        display: block;
      }
    `;
    container.appendChild(styleEl);
    this.styleEl = styleEl;

    const root = document.createElement('div');
    root.className = 'ai-trans-overlay';
    // 基礎定位樣式（固定值，安全）。
    const base: Record<string, string> = {
      position: 'absolute',
      bottom: '12%',
      left: '50%',
      transform: 'translateX(-50%)',
      'text-align': 'center',
      'max-width': '90%',
      'pointer-events': 'none',
      'z-index': '2147483647',
    };
    for (const [k, v] of Object.entries(base)) root.style.setProperty(k, v);
    // R8：用戶自填樣式值改用 setProperty（瀏覽器會拒絕非法值），不拼進 cssText。
    // display-mode 為內部渲染開關，不是 CSS 屬性，跳過。
    for (const [k, v] of Object.entries(style)) {
      if (k === 'display-mode') continue;
      root.style.setProperty(this.kebab(k), v);
    }

    container.appendChild(root);
    this.root = root;
    diagLog('overlay', 'mount() completed, root appended to container');
  }

  render(cues: RenderableCue[], currentTime: Millis): void {
    // 降壓：只在 cues 數量變化時才記錄 render() 調用
    if (cues.length !== this.lastLoggedCueCount) {
      diagLog('overlay', 'render() called, cues:', cues.length, 'currentTime:', currentTime);
      this.lastLoggedCueCount = cues.length;
    }
    this.cues = cues;
    this.draw(currentTime);
  }

  updateProvisional(cue: RenderableCue): void {
    const idx = this.cues.findIndex((c) => c.id === cue.id);
    if (idx >= 0) {
      this.cues[idx] = cue;
    } else {
      this.cues.push(cue);
    }
    if (this.currentId === cue.id) {
      this.renderActive(cue);
    }
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.styleEl?.remove();
    this.styleEl = null;
    this.currentId = null;
  }

  private draw(currentTime: Millis): void {
    const active = this.cues.find(
      (c) => currentTime >= c.start && currentTime < c.end
    );
    if (active) {
      // 降壓：只在切換到新 cue 時才記錄
      if (active.id !== this.lastLoggedActiveId) {
        diagLog('overlay', 'draw() found active cue:', active.id, 'start:', active.start, 'end:', active.end);
        this.lastLoggedActiveId = active.id;
      }
      this.currentId = active.id;
      this.renderActive(active);
    } else {
      // 降壓：沒有 active cue 時，每 5 秒最多記錄一次
      const now = Date.now();
      if (now - this.lastNoCueLogTime >= NO_CUE_LOG_INTERVAL_MS) {
        diagLog('overlay', 'draw() no active cue for currentTime:', currentTime, 'cues:', this.cues.length);
        if (this.cues.length > 0) {
          diagLog('overlay', 'first cue range:', this.cues[0].start, '-', this.cues[0].end);
          // D1：記錄完整覆蓋範圍（min start - max end）與 gap vs currentTime。
          const minStart = Math.min(...this.cues.map(c => c.start));
          const maxEnd = Math.max(...this.cues.map(c => c.end));
          const gap = currentTime - maxEnd;
          diagLog('overlay', 'full coverage:', minStart, '-', maxEnd, 'ms, gap vs currentTime:', gap, 'ms', gap > 0 ? '(behind)' : '(ahead)');
        }
        this.lastNoCueLogTime = now;
      }
      this.clear();
    }
  }

  private renderActive(cue: RenderableCue): void {
    if (!this.root) return;
    const bilingual = this.style['display-mode'] !== 'mono';
    const parts: string[] = [];
    // M2-32：雙語模式下去重——當 sourceText 與 translatedText 相同時（如 source=en, target=en），只顯示一行。
    if (bilingual && cue.sourceText && cue.sourceText !== cue.translatedText) {
      parts.push(`<span class="ai-trans-src">${escapeHtml(cue.sourceText)}</span>`);
    }
    parts.push(`<span class="ai-trans-dst">${escapeHtml(cue.translatedText)}</span>`);
    this.root.innerHTML = parts.join('');
    this.root.dataset.provisional = String(cue.provisional);
  }

  private clear(): void {
    if (this.root) {
      this.root.innerHTML = '';
      this.currentId = null;
    }
  }

  private kebab(k: string): string {
    return k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
