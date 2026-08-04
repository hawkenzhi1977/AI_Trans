// 內容腳本入口：在 YouTube watch 頁注入並啟動 M1 翻譯流程。
import { Orchestrator } from '../application';
import { buildDefaultRegistry } from './composition';
import { ChromeStorageConfigStore } from '../infrastructure/chrome-config-store';
import { OverlayRenderer } from '../adapters/render/overlay-renderer';

const store = new ChromeStorageConfigStore();

async function start(): Promise<void> {
  const config = await store.get();
  const registry = buildDefaultRegistry(config);

  // 掛載渲染器到播放器容器。
  const renderer = new OverlayRenderer();
  try {
    const mount = registry.platforms[0]!.mountPoint();
    renderer.mount(mount, {
      'font-size': '24px',
      color: '#fff',
      'text-shadow': '0 1px 3px rgba(0,0,0,.8)',
      'display-mode': config.displayMode,
    });
  } catch {
    // 播放器尚未就緒——M1 暫不自動重試，由用戶手動觸發（見 popup）。
  }

  const orchestrator = new Orchestrator(
    { registry, getConfig: () => store.get(), enableAsr: false },
    (e) => {
      // M1：渲染事件推送給 overlay。
      if (e.type === 'segments-ready') {
        const cues = e.segments.map((s) => ({
          id: s.id,
          sourceText: s.sourceText,
          translatedText: s.translatedText ?? s.sourceText,
          provisional: s.provisional,
          start: s.start,
          end: s.end,
        }));
        renderer.render(cues, 0);
      }
    }
  );

  await orchestrator.start(window.location.href);
}

void start();
