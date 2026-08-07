import type { RenderableCue } from '../../domain/ports/subtitle-renderer';
import type { SubtitleRenderer } from '../../domain/ports/subtitle-renderer';
import type { Millis } from '../../domain/models/subtitle';

/**
 * 覆蓋層字幕渲染器——注入播放器容器上方的透明層。
 * 支持單語/雙語、provisional 原地更新、rAF 對齊播放時間。
 */
export class OverlayRenderer implements SubtitleRenderer {
  private root: HTMLElement | null = null;
  private style: Record<string, string> = {};
  private cues: RenderableCue[] = [];
  private currentId: string | null = null;

  mount(container: HTMLElement, style: Record<string, string> = {}): void {
    console.log('[AI_Trans:diag] overlay-renderer: mount() called, container:', container.tagName, container.className);
    console.log('[AI_Trans:diag] overlay-renderer: container computed position:', getComputedStyle(container).position, 'overflow:', getComputedStyle(container).overflow);
    this.style = style;

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
    console.log('[AI_Trans:diag] overlay-renderer: mount() completed, root appended to container');
  }

  render(cues: RenderableCue[], currentTime: Millis): void {
    console.log('[AI_Trans:diag] overlay-renderer: render() called, cues:', cues.length, 'currentTime:', currentTime);
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
    this.currentId = null;
  }

  private draw(currentTime: Millis): void {
    const active = this.cues.find(
      (c) => currentTime >= c.start && currentTime < c.end
    );
    if (active) {
      console.log('[AI_Trans:diag] overlay-renderer: draw() found active cue:', active.id, 'start:', active.start, 'end:', active.end);
      this.currentId = active.id;
      this.renderActive(active);
    } else {
      console.log('[AI_Trans:diag] overlay-renderer: draw() no active cue found for currentTime:', currentTime, 'cues:', this.cues.length);
      if (this.cues.length > 0) {
        console.log('[AI_Trans:diag] overlay-renderer: first cue range:', this.cues[0].start, '-', this.cues[0].end);
      }
      this.clear();
    }
  }

  private renderActive(cue: RenderableCue): void {
    console.log('[AI_Trans:diag] overlay-renderer: renderActive() called, root exists:', !!this.root);
    if (!this.root) return;
    const bilingual = this.style['display-mode'] !== 'mono';
    const parts: string[] = [];
    if (bilingual && cue.sourceText) {
      parts.push(`<span class="ai-trans-src">${escapeHtml(cue.sourceText)}</span>`);
    }
    parts.push(`<span class="ai-trans-dst">${escapeHtml(cue.translatedText)}</span>`);
    this.root.innerHTML = parts.join('<br/>');
    this.root.dataset.provisional = String(cue.provisional);
    
    // 詳細診斷
    const rect = this.root.getBoundingClientRect();
    const computed = getComputedStyle(this.root);
    console.log('[AI_Trans:diag] overlay-renderer: === RENDER DIAGNOSTICS ===');
    console.log('[AI_Trans:diag] overlay-renderer: innerHTML:', this.root.innerHTML.substring(0, 150));
    console.log('[AI_Trans:diag] overlay-renderer: bounding rect:', { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right });
    console.log('[AI_Trans:diag] overlay-renderer: computed styles:', {
      display: computed.display,
      visibility: computed.visibility,
      opacity: computed.opacity,
      zIndex: computed.zIndex,
      position: computed.position,
      pointerEvents: computed.pointerEvents,
      color: computed.color,
      fontSize: computed.fontSize,
      backgroundColor: computed.backgroundColor
    });
    console.log('[AI_Trans:diag] overlay-renderer: parent element:', this.root.parentElement?.tagName, this.root.parentElement?.className?.substring(0, 50));
    console.log('[AI_Trans:diag] overlay-renderer: === END DIAGNOSTICS ===');
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
