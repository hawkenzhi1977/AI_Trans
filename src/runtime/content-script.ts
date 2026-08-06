// 內容腳本入口：在 YouTube watch 頁注入並啟動 M1 翻譯流程。
// 職責：加載配置 → 組裝 Registry → 自動掛載渲染器 → 訂閱播放狀態驅動渲染 → 啟動 Orchestrator。
import { Orchestrator } from '../application';
import { buildDefaultRegistry } from './composition';
import { ChromeStorageConfigStore } from '../infrastructure/chrome-config-store';
import { recordDiagnostic } from '../infrastructure/diagnostics';
import { OverlayRenderer } from '../adapters/render/overlay-renderer';
import { TimedTextBridge } from './timedtext-bridge';
import type { RenderableCue } from '../domain/ports/subtitle-renderer';
import type { PipelineEvent } from '../domain/models/events';
import type { EngineConfig } from '../domain/models/config';

/** 內容腳本側的播放器容器選擇器（YouTube + Mock 站點）。 */
const PLAYER_SELECTOR = 'div#movie_player, .html5-video-player, #mock-player';

/** 等待播放器出現的超時（毫秒）：超時放棄等待，避免 Promise 永久懸掛。 */
const MOUNT_WAIT_TIMEOUT_MS = 15_000;

const store = new ChromeStorageConfigStore();

class SubtitleController {
  private renderer = new OverlayRenderer();
  private cues: RenderableCue[] = [];
  private currentTime = 0;
  private mounted = false;
  private orchestrator: Orchestrator | null = null;
  private rafId = 0;
  private readonly url: string;
  // MAIN world 播放器 timedtext 響應攔截橋：捕獲播放器真實請求（含 pot），供字幕管線複用。
  private readonly bridge = new TimedTextBridge();
  // R4：所有需解除的訂閱句柄，restart/stop 前必須全部清理，避免線性累積。
  private unsubscribePlayback: (() => void) | null = null;
  private unsubscribeConfig: (() => void) | null = null;
  private pendingMountObserver: MutationObserver | null = null;
  private mountWaitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: EngineConfig, url: string) {
    this.url = url;
    // 配置變更（Options 頁保存）→ 熱重啟。
    // 注意：Options 與 content-script 是不同 JS 上下文，store.subscribe 的內存回調不跨上下文；
    // 必須監聽 chrome.storage.onChanged 才能收到跨頁變更（engineConfig / engineConfigKeys 兩個 key）。
    // R4：保存 unsubscribe，dispose 時解除。
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ): void => {
      if (areaName !== 'local') return;
      if ('engineConfig' in changes || 'engineConfigKeys' in changes) {
        // §5.5/R6：restart 拋錯必須落診斷，不許未捕獲懸掛 Promise 靜默消失。
        void this.restart().catch((err) => {
          recordDiagnostic({
            type: 'pipeline-error',
            error: {
              port: 'platform',
              code: 'config-hot-reload-failed',
              recoverable: true,
              cause: err instanceof Error ? err : new Error(String(err)),
            },
          });
        });
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    this.unsubscribeConfig = () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }

  /** 加載配置 → 組裝 → 掛載 → 啟動 Orchestrator。 */
  async start(): Promise<void> {
    // MAIN world 攔截器：hook 播放器 XHR/fetch 捕獲 timedtext 響應（含 pot）。
    // 必須在字幕管線請求前注入並啟動監聽，否則播放器先發請求時捕獲會漏；
    // 提前到 ensureMounted 之前，讓攔截器儘早安裝（M1-43）。
    this.bridge.inject();
    this.bridge.start();

    await this.ensureMounted();

    // 測試環境（localhost Mock 站點）放寬平台匹配規則，使 YouTube 適配器接管 mock 頁。
    const isMockHost = /^https?:\/\/localhost(:\d+)?\//.test(this.url);
    const platformWatchRe = isMockHost
      ? /^https?:\/\/localhost(:\d+)?\//
      : undefined;

    const registry = await buildDefaultRegistry(this.config, {
      apiKeyStore: store,
      platformWatchRe,
      captionCaptureProvider: this.bridge,
    });
    this.orchestrator = new Orchestrator(
      { registry, getConfig: () => store.get(), enableAsr: false },
      (e) => this.onEvent(e)
    );

    // 播放狀態驅動渲染：時間推進時用 rAF 對齊重繪。
    // R4/R6：observePlayback 返回 unsubscribe 必須保存並在 stop 解除；
    // platforms[0] 缺失屬異常，顯式判空並發降級事件（不用可選鏈靜默吞掉）。
    const platform = registry.platforms[0];
    if (!platform) {
      this.onEvent({
        type: 'pipeline-error',
        error: {
          port: 'platform',
          code: 'no-platform-adapter',
          recoverable: false,
          cause: new Error('registry.platforms is empty'),
        },
      });
    } else {
      this.unsubscribePlayback = platform.observePlayback((state) => {
        this.currentTime = state.currentTime;
        this.scheduleDraw();
      });
    }

    await this.orchestrator.start(this.url);
  }

  /** 配置變更後熱重啟：停止舊管線 → 讀新配置 → 重新啟動。 */
  async restart(): Promise<void> {
    this.stop();
    this.config = await store.get();
    await this.start();
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    // R4：中斷等待型 MutationObserver 與其超時，避免 restart 期間洩漏/懸掛。
    this.pendingMountObserver?.disconnect();
    this.pendingMountObserver = null;
    if (this.mountWaitTimer !== null) {
      clearTimeout(this.mountWaitTimer);
      this.mountWaitTimer = null;
    }
    // R4：解除本控制器持有的 observePlayback 訂閱（Orchestrator 內另有一份自行清理）。
    this.unsubscribePlayback?.();
    this.unsubscribePlayback = null;
    // R4：暫停 MAIN world 攔截橋的消息監聽與輪詢，但**保留 latest 捕獲緩存**
    // （restart 熱重載後字幕已加載的播放器不會再發請求，丟緩存會永久回退 fetch）。
    this.bridge.stop();
    this.orchestrator?.stop();
    this.orchestrator = null;
    this.renderer.unmount();
    this.mounted = false;
    this.cues = [];
  }

  /** 徹底銷毀：解除配置訂閱（頁面卸載/SPA 導航離開時調用）。 */
  dispose(): void {
    this.stop();
    // R4：真正銷毀時才清空捕獲緩存（stop 保留，dispose 清空）。
    this.bridge.dispose();
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
  }

  private onEvent(e: PipelineEvent): void {
    if (e.type === 'segments-ready' || e.type === 'segments-updated') {
      this.cues = e.segments.map((s) => ({
        id: s.id,
        sourceText: s.sourceText,
        translatedText: s.translatedText ?? s.sourceText,
        provisional: s.provisional,
        start: s.start,
        end: s.end,
      }));
      this.scheduleDraw();
      return;
    }
    // 降級/錯誤事件：持久化診斷 + console 麵包屑，讓「字幕沒出來」的原因可被用戶查詢。
    // 異步寫入不阻塞事件處理；recordDiagnostic 內部已 try/catch 守護（§5.7）。
    void recordDiagnostic(e);
  }

  /** 播放器就緒後自動掛載覆蓋層；未就緒時等待 DOM 出現（YouTube 播放器異步加載）。 */
  private async ensureMounted(): Promise<void> {
    if (!document.querySelector(PLAYER_SELECTOR)) {
      // R4/R5：存 observer 句柄可被 stop 中斷；加超時避免播放器永不出現時 Promise 永久懸掛。
      let timedOut = false;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (fromTimeout: boolean) => {
          if (settled) return;
          settled = true;
          if (fromTimeout) timedOut = true;
          this.pendingMountObserver?.disconnect();
          this.pendingMountObserver = null;
          if (this.mountWaitTimer !== null) {
            clearTimeout(this.mountWaitTimer);
            this.mountWaitTimer = null;
          }
          resolve();
        };
        const mo = new MutationObserver(() => {
          if (document.querySelector(PLAYER_SELECTOR)) finish(false);
        });
        this.pendingMountObserver = mo;
        mo.observe(document.body, { childList: true, subtree: true });
        // 15s 超時：超時後放棄等待（mountOverlay 會因無播放器安全跳過）。
        this.mountWaitTimer = setTimeout(() => finish(true), MOUNT_WAIT_TIMEOUT_MS);
      });
      // §5.6：播放器 15s 未出現屬關鍵節點失敗，不允許靜默——落診斷讓 popup「最近失敗」可查。
      // （正常情況播放器會出現；超時說明播放器被移除/SPA 切頁/頁面變體，字幕不出的原因必須可見。）
      if (timedOut) {
        this.onEvent({
          type: 'pipeline-error',
          error: {
            port: 'platform',
            code: 'player-not-found',
            recoverable: true,
            cause: new Error(
              `player not found within ${MOUNT_WAIT_TIMEOUT_MS}ms (selector: ${PLAYER_SELECTOR})`
            ),
          },
        });
      }
    }
    this.mountOverlay();
  }

  private mountOverlay(): void {
    const player = document.querySelector<HTMLElement>(PLAYER_SELECTOR);
    if (!player || this.mounted) return;
    this.renderer.mount(player, {
      'font-size': this.config.subtitleStyle?.['font-size'] ?? '24px',
      color: this.config.subtitleStyle?.color ?? '#fff',
      'text-shadow': '0 1px 3px rgba(0,0,0,.8)',
      'background-color': this.config.subtitleStyle?.['background-color'] ?? 'transparent',
      'display-mode': this.config.displayMode,
    });
    this.mounted = true;
  }

  /** rAF 對齊：避免每幀重排，僅在時間跨段時重繪。 */
  private scheduleDraw(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      if (this.mounted) this.renderer.render(this.cues, this.currentTime);
    });
  }
}

async function start(): Promise<void> {
  let config: EngineConfig;
  try {
    config = await store.get();
  } catch (err) {
    // §5.5/R6：啟動讀取配置失敗不能成未捕獲懸掛——記錄診斷並中止，避免後續全鏈失敗。
    recordDiagnostic({
      type: 'pipeline-error',
      error: {
        port: 'platform',
        code: 'config-load-failed',
        recoverable: false,
        cause: err instanceof Error ? err : new Error(String(err)),
      },
    });
    return;
  }
  const controller = new SubtitleController(config, window.location.href);
  await controller.start();
}

void start().catch((err) => {
  // §5.5：頂層兜底——任何未捕獲異常都落診斷，不靜默。
  recordDiagnostic({
    type: 'pipeline-error',
    error: {
      port: 'platform',
      code: 'content-script-start-failed',
      recoverable: false,
      cause: err instanceof Error ? err : new Error(String(err)),
    },
  });
});
