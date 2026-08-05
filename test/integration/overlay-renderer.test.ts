import { describe, it, expect } from 'vitest';
import { OverlayRenderer } from '../../src/adapters/render/overlay-renderer';
import type { RenderableCue } from '../../src/domain/ports/subtitle-renderer';

function cue(id: string, start: number, end: number, translated: string): RenderableCue {
  return { id, start, end, translatedText: translated, provisional: false, sourceText: `src-${id}` };
}

describe('OverlayRenderer 播放狀態驅動渲染（M1-26）', () => {
  it('依 currentTime 選中時間窗內的字幕段', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = new OverlayRenderer();
    r.mount(container, { 'display-mode': 'mono' });

    const cues = [cue('a', 0, 2000, '譯A'), cue('b', 2000, 4000, '譯B')];
    r.render(cues, 1500);
    const root = container.querySelector<HTMLElement>('.ai-trans-overlay');
    expect(root?.textContent).toContain('譯A');

    r.render(cues, 2500);
    expect(root?.textContent).toContain('譯B');

    r.render(cues, 5000);
    expect(root?.textContent).toBe('');
  });

  it('雙語模式顯示原文 + 譯文', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = new OverlayRenderer();
    r.mount(container, { 'display-mode': 'bilingual' });

    r.render([cue('a', 0, 2000, '譯A')], 1000);
    const root = container.querySelector<HTMLElement>('.ai-trans-overlay');
    expect(root?.textContent).toContain('src-a');
    expect(root?.textContent).toContain('譯A');
  });

  it('單語模式不顯示原文', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = new OverlayRenderer();
    r.mount(container, { 'display-mode': 'mono' });

    r.render([cue('a', 0, 2000, '譯A')], 1000);
    const root = container.querySelector<HTMLElement>('.ai-trans-overlay');
    expect(root?.textContent).toContain('譯A');
    expect(root?.textContent).not.toContain('src-a');
  });

  it('updateProvisional 原地更新當前字幕（revision 修正）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = new OverlayRenderer();
    r.mount(container, { 'display-mode': 'mono' });

    r.render([cue('a', 0, 2000, '初稿')], 500);
    const root = container.querySelector<HTMLElement>('.ai-trans-overlay');
    expect(root?.textContent).toContain('初稿');

    r.updateProvisional({ ...cue('a', 0, 2000, '修正稿'), provisional: true });
    expect(root?.textContent).toContain('修正稿');
    expect(root?.dataset.provisional).toBe('true');
  });

  it('播放範圍外清空字幕', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = new OverlayRenderer();
    r.mount(container, { 'display-mode': 'mono' });

    r.render([cue('a', 0, 2000, '譯A')], 1000);
    r.render([cue('a', 0, 2000, '譯A')], 2100);
    const root = container.querySelector<HTMLElement>('.ai-trans-overlay');
    expect(root?.textContent).toBe('');
  });

  it('unmount 移除覆蓋層節點', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = new OverlayRenderer();
    r.mount(container, {});
    expect(container.querySelector('.ai-trans-overlay')).toBeTruthy();
    r.unmount();
    expect(container.querySelector('.ai-trans-overlay')).toBeNull();
  });
});
