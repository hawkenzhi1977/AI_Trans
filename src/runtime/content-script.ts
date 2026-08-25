// 內容腳本入口：在 YouTube watch 頁注入並啟動 M1 翻譯流程。
// 職責：加載配置 → 組裝 Registry → 自動掛載渲染器 → 訂閱播放狀態驅動渲染 → 啟動 Orchestrator。
import { Orchestrator } from '../application';
import { LateCaptureRetry } from '../application/late-capture-retry';
import { buildDefaultRegistry } from './composition';
import { ChromeStorageConfigStore } from '../infrastructure/chrome-config-store';
import { recordDiagnostic } from '../infrastructure/diagnostics';
import { diagLog, setDebugFlags } from '../infrastructure/debug-log';
import { OverlayRenderer } from '../adapters/render/overlay-renderer';
import { TimedTextBridge } from './timedtext-bridge';
import type { TimedTextCapture } from './timedtext-bridge';
import { isWatchPage } from './watch-url';
import type { RenderableCue } from '../domain/ports/subtitle-renderer';
import type { PipelineEvent } from '../domain/models/events';
import type { EngineConfig } from '../domain/models/config';

/** 內容腳本側的播放器容器選擇器（YouTube + Mock 站點）。 */
const PLAYER_SELECTOR = 'div#movie_player, .html5-video-player, #mock-player';

/** 從 watch URL 提取視頻 ID（`/watch?v=` 的 v 參數）；非 watch 頁或無參數返回空串。 */
function extractVideoId(url: string): string {
  try {
    return new URL(url).searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}

/** 等待播放器出現的超時（毫秒）：超時放棄等待，避免 Promise 永久懸掛。 */
const MOUNT_WAIT_TIMEOUT_MS = 15_000;

/**
 * M2-24 補充修復十四：晚捕獲重試上限與冷卻。
 * 真實環境根因：pot 重驅動鏈（無 pot 掛起 → 2s 排程 → 播放器帶 pot 重發）常超過
 * waitForCapture 的 15s 窗口，捕獲成功但管線已永久降級。此機制在管線降級後仍訂閱
 * bridge 的新捕獲事件，捕獲到達時輕量重跑策略鏈讓 native 複用晚捕獲。上限防止
 * 捕獲持續到達但解析仍失敗時無限重啟。
 */
const MAX_LATE_CAPTURE_RETRIES = 3;
/** 晚捕獲重試的冷卻間隔（毫秒）：捕獲重播 1.5s 一次，過濾後同 capturedAt 只觸發一次，故以重試間隔為準。 */
const LATE_CAPTURE_RETRY_COOLDOWN_MS = 5_000;

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
  private unsubscribeAsrAuth: (() => void) | null = null;
  // M2-24 補充修復十四：bridge 新捕獲訂閱句柄（R4：stop/dispose 必須解除）。
  private unsubscribeCapture: (() => void) | null = null;
  // M2-24 補充修復十四：晚捕獲重試狀態機（no-caption-strategy 降級後等待捕獲到達重試）。
  private readonly lateCaptureRetry = new LateCaptureRetry({
    maxRetries: MAX_LATE_CAPTURE_RETRIES,
    cooldownMs: LATE_CAPTURE_RETRY_COOLDOWN_MS,
  });
  private pendingMountObserver: MutationObserver | null = null;
  private mountWaitTimer: ReturnType<typeof setTimeout> | null = null;
  // M1-51：調試旗標中繼重播定時器（跨 world 監聽器晚就位場景），restart/stop 清理（R4）。
  private debugFlagRelayTimer: ReturnType<typeof setInterval> | null = null;
  // M2-14：tabCapture 授權狀態（content-script 啟動時讀取，授權變更時熱重啟）。
  private tabCaptureAuthorized = false;
  // SPA 換視頻監聽（M1-45）：YouTube 換視頻走 pushState，content-script 不會重載；
  // 偵測 URL 的 v 參數變化後熱重啟字幕管線。dispose 時必須解除/恢復（R4）。
  private readonly onUrlChangedBound: () => void;
  private readonly origPushState: typeof history.pushState;
  private readonly origReplaceState: typeof history.replaceState;
  private readonly patchedHistory: boolean;
  private lastVideoId: string;
  private urlChangeTimer: ReturnType<typeof setTimeout> | null = null;
  // M2-21：URL 輪詢偵測（兜底機制）：YouTube 可能覆蓋我們的 pushState patch，
  // 導致 onUrlChanged() 不被觸發。定期檢查 location.href 變化作為兜底。
  private urlPollTimer: ReturnType<typeof setInterval> | null = null;
  /** URL 輪詢間隔（毫秒）：1.5 秒檢查一次，平衡響應速度與性能。 */
  private static readonly URL_POLL_INTERVAL_MS = 1500;

  constructor(private config: EngineConfig, url: string) {
    this.url = url;
    this.lastVideoId = extractVideoId(url);
    this.onUrlChangedBound = this.onUrlChanged.bind(this);
    // SPA 導航監聽：popstate 捕獲後退/前進；pushState/replaceState 捕獲
    // YouTube 前進式換視頻（標準事件不觸發，需 patch 攔截）。M1-45。
    globalThis.addEventListener('popstate', this.onUrlChangedBound);
    this.origPushState = history.pushState;
    this.origReplaceState = history.replaceState;
    // §5.7：patch 是替換宿主方法——必須保留原始引用並在 dispose 恢復，防止洩漏/疊加。
    this.patchedHistory = this.patchHistoryApi();
    this.urlChangeTimer = null;
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

    // M2-14：監聽 tabCapture 授權狀態變更（Popup「啟用 ASR」按鈕寫入）。
    // 授權成功後熱重啟字幕管線（enableAsr 切換為 true）。
    const onAsrAuthChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ): void => {
      if (areaName !== 'local' || !('tabCaptureAuthorized' in changes)) return;
      const newValue = changes.tabCaptureAuthorized.newValue as boolean;
      if (newValue === this.tabCaptureAuthorized) return; // 無變化。
      this.tabCaptureAuthorized = newValue;
      // §5.5/R6：授權變更後重啟失敗必須落診斷。
      void this.restart().catch((err) => {
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'platform',
            code: 'asr-auth-restart-failed',
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err)),
          },
        });
      });
    };
    chrome.storage.onChanged.addListener(onAsrAuthChanged);
    this.unsubscribeAsrAuth = () => chrome.storage.onChanged.removeListener(onAsrAuthChanged);
  }

  /** 加載配置 → 組裝 → 掛載 → 啟動 Orchestrator。 */
  async start(): Promise<void> {
    // M2-30：整體開關守衛——停用時不啟動管線，恢復 YouTube 原生字幕。
    if (!this.config.enabled) {
      diagLog('content', 'start() skipped: extension disabled by user');
      // M2-31：通知 MAIN world 攔截器停用（即使攔截器已注入，也停止字幕抑制邏輯）。
      document.dispatchEvent(new CustomEvent('ai-trans:disable'));
      return;
    }
    // M2-31：通知 MAIN world 攔截器重新啟用。
    document.dispatchEvent(new CustomEvent('ai-trans:enable'));

    // M2-14：讀取 tabCapture 授權狀態（初始值，後續由 storage.onChanged 監聽更新）。
    const authState = await chrome.storage.local.get('tabCaptureAuthorized');
    this.tabCaptureAuthorized = authState.tabCaptureAuthorized === true;

    // M1-51：套用調試日誌分類開關（content-script 側），並中繼給 MAIN world 攔截器
    // （interceptor 無法訪問 chrome.storage，靠 CustomEvent 同步旗標）。
    this.applyDebugFlags();

    // MAIN world 攔截器：hook 播放器 XHR/fetch 捕獲 timedtext 響應（含 pot）。
    // 必須在字幕管線請求前注入並啟動監聽，否則播放器先發請求時捕獲會漏；
    // 提前到 ensureMounted 之前，讓攔截器儘早安裝（M1-43）。
    this.bridge.inject();
    this.bridge.start();

    // M2-24 補充修復十四：訂閱 bridge 的新捕獲事件——管線因 pot 捕獲晚到而降級
    // （no-caption-strategy）後，捕獲到達時輕量重跑策略鏈（見 onBridgeCapture）。
    // R4：unsubscribe 返回值必須保存，stop() 時解除，不隨 restart 線性累積。
    this.unsubscribeCapture = this.bridge.onCapture((capture) => {
      this.onBridgeCapture(capture);
    });

    // M1-47：通知 MAIN world 攔截器目標翻譯語言——攔截器收到後主動驅動播放器字幕模組
    // 發帶 pot 的 timedtext 請求（CC 關閉時播放器默認不發，攔截器捕獲不到）。
    // 目標語言用於內容腳本後續翻譯，此處僅作為「重新驅動字幕載入」的觸發信號。
    // 使用 CustomEvent 替代 postMessage，避免 isolated world 與 MAIN world 之間的通信問題。
    document.dispatchEvent(
      new CustomEvent('ai-trans:set-target-lang', {
        detail: { targetLang: this.config.targetLang }
      })
    );
    diagLog('content', 'Sent set-target-lang message to MAIN world:', this.config.targetLang);

    // M1-47：讀取當前 URL（會話恢復後 tab 先為首頁，之後 SPA 導航到 /watch）。
    // 非 watch 頁時靜默返回（不發降級事件），保持攔截器與 SPA 監聽存活，
    // 待 SPA 導航後由 onUrlChanged→restart 接管。
    const currentUrl = this.currentUrl();
    // M2-22 補充：非 watch 頁仍需啟動 URL 輪詢，否則從 /feed/history 等頁面
    // 導航到視頻頁時無法偵測（pushState patch 可能被 YouTube 覆蓋）。
    this.startUrlPolling();
    if (!isWatchPage(currentUrl)) {
      return;
    }

    await this.ensureMounted();

    // 測試環境（localhost Mock 站點）放寬平台匹配規則，使 YouTube 適配器接管 mock 頁。
    const isMockHost = /^https?:\/\/localhost(:\d+)?\//.test(currentUrl);
    const platformWatchRe = isMockHost
      ? /^https?:\/\/localhost(:\d+)?\//
      : undefined;

    const registry = await buildDefaultRegistry(this.config, {
      apiKeyStore: store,
      platformWatchRe,
      captionCaptureProvider: this.bridge,
    });
    // M2-14：enableAsr 由 tabCapture 授權狀態驅動（Popup「啟用 ASR」按鈕觸發授權）。
    this.orchestrator = new Orchestrator(
      { registry, getConfig: () => store.get(), enableAsr: this.tabCaptureAuthorized },
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

    await this.orchestrator.start(currentUrl);
  }

  /** 取得當前頁面 URL（M1-47：每次 start/restart 都讀最新 location）。 */
  private currentUrl(): string {
    return globalThis.location?.href ?? this.url;
  }

  /**
   * M1-51：套用調試日誌分類開關。
   * - content-script（isolated world）：直接 setDebugFlags。
   * - MAIN world 攔截器：無法訪問 chrome.storage，通過 CustomEvent 中繼旗標
   *   （與 set-target-lang 同一模式，跨 world 通信走 DOM 事件——M1-47 教訓）。
   *   攔截器 `<script>` 異步加載可能晚於首次 dispatch（監聽器未就位），
   *   故短窗口內（6 × 0.5s）周期重發，確保晚就位的攔截器也能收到（M1-46 重播教訓）。
   */
  private applyDebugFlags(): void {
    setDebugFlags(this.config.debugLog);
    const dispatch = () =>
      document.dispatchEvent(
        new CustomEvent('ai-trans:set-debug-flags', {
          detail: { flags: this.config.debugLog },
        })
      );
    dispatch();
    if (this.debugFlagRelayTimer !== null) {
      clearInterval(this.debugFlagRelayTimer);
      this.debugFlagRelayTimer = null;
    }
    let relayed = 0;
    // R4：重播定時器句柄留存，重發 6 次（3s）後自清；restart/stop 會清理。
    this.debugFlagRelayTimer = setInterval(() => {
      relayed += 1;
      dispatch();
      if (relayed >= 6) {
        if (this.debugFlagRelayTimer !== null) {
          clearInterval(this.debugFlagRelayTimer);
          this.debugFlagRelayTimer = null;
        }
      }
    }, 500);
  }

  /** 配置變更後熱重啟：停止舊管線 → 讀新配置 → 重新啟動。 */
  async restart(): Promise<void> {
    diagLog('content', 'restart() called');
    this.stop();
    diagLog('content', 'restart() stop() completed');
    this.config = await store.get();
    // M2-30：停用時不重新啟動管線。
    if (!this.config.enabled) {
      diagLog('content', 'restart() stopped: extension disabled');
      return;
    }
    await this.start();
    diagLog('content', 'restart() start() completed');
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    // M2-21：停止 URL 輪詢偵測（§5.4：註冊必配解除）。
    this.stopUrlPolling();
    // R4：中斷等待型 MutationObserver 與其超時，避免 restart 期間洩漏/懸掛。
    this.pendingMountObserver?.disconnect();
    this.pendingMountObserver = null;
    if (this.mountWaitTimer !== null) {
      clearTimeout(this.mountWaitTimer);
      this.mountWaitTimer = null;
    }
    // M1-51：調試旗標中繼重播定時器（§5.4：註冊必配解除）。
    if (this.debugFlagRelayTimer !== null) {
      clearInterval(this.debugFlagRelayTimer);
      this.debugFlagRelayTimer = null;
    }
    // R4：解除本控制器持有的 observePlayback 訂閱（Orchestrator 內另有一份自行清理）。
    this.unsubscribePlayback?.();
    this.unsubscribePlayback = null;
    // M2-24 補充修復十四：解除 bridge 新捕獲訂閱並重置晚捕獲重試狀態
    // （restart/換視頻後上一輪的 waiting/計數不得殘留，R4 + 防誤重試）。
    this.unsubscribeCapture?.();
    this.unsubscribeCapture = null;
    this.lateCaptureRetry.disarm();
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
    // R4：解除 tabCapture 授權監聽（§5.4）。
    this.unsubscribeAsrAuth?.();
    this.unsubscribeAsrAuth = null;
    // R4：解除 SPA 導航監聽並恢復被 patch 的 history API（防止疊加/洩漏）。
    globalThis.removeEventListener('popstate', this.onUrlChangedBound);
    if (this.patchedHistory) {
      // §5.7/R2：恢復原始引用，禁止被多次 patch 後嵌套疊加。
      history.pushState = this.origPushState;
      history.replaceState = this.origReplaceState;
    }
  }

  /**
   * M2-21：啟動 URL 輪詢偵測（兜底機制）。
   * 
   * 背景：YouTube 的 SPA 導航機制可能覆蓋我們的 `history.pushState/replaceState` patch，
   * 導致 `onUrlChanged()` 不被觸發。定期檢查 `location.href` 的 `v` 參數變化作為兜底。
   * 
   * 設計：
   * - 每 1.5 秒檢查一次 `location.href` 的 `v` 參數
   * - 偵測到變化時調用 `onUrlChanged()`（已有 debounce 機制，不衝突）
   * - 與 pushState patch 共存，不重複觸發（`onUrlChanged()` 的 debounce 確保）
   */
  private startUrlPolling(): void {
    if (this.urlPollTimer !== null) return; // 已啟動，不重複
    diagLog('content', 'startUrlPolling: starting URL polling with interval', SubtitleController.URL_POLL_INTERVAL_MS, 'ms');
    this.urlPollTimer = setInterval(() => {
      const currentVideoId = extractVideoId(window.location.href);
      if (currentVideoId !== this.lastVideoId) {
        diagLog('content', 'urlPollTimer: videoId changed from', this.lastVideoId, 'to', currentVideoId);
        this.onUrlChanged();
      }
    }, SubtitleController.URL_POLL_INTERVAL_MS);
  }

  /** M2-21：停止 URL 輪詢偵測（§5.4：註冊必配解除）。 */
  private stopUrlPolling(): void {
    if (this.urlPollTimer !== null) {
      clearInterval(this.urlPollTimer);
      this.urlPollTimer = null;
      diagLog('content', 'stopUrlPolling: URL polling stopped');
    }
  }

  /** 偵測 URL 的 v 參數變化（SPA 換視頻）→ 熱重啟字幕管線（M1-45）。 */
  private onUrlChanged(): void {
    // debounce：同一導航可能 popstate 與 pushState 各觸發一次，避免重複 restart。
    if (this.urlChangeTimer !== null) return;
    const videoId = extractVideoId(window.location.href);
    diagLog('content', 'onUrlChanged triggered:', 'oldVideoId:', this.lastVideoId, 'newVideoId:', videoId, 'url:', window.location.href);
    if (videoId === this.lastVideoId) return; // 同一視頻（如僅參數調整），不重啟。
    this.lastVideoId = videoId;
    // 視頻切換時清空 timedtext 緩存，避免複用舊視頻字幕。
    this.bridge.clearLatest();
    // M2-22：通知 MAIN world 攔截器視頻已切換——清空 stale 捕獲並重新驅動字幕模組。
    // 背景：攔截器的 `lastCapture` 在 MAIN world，`bridge.clearLatest()` 只清空 isolated world
    // 的緩存。攔截器的重播機制會持續發送 stale 捕獲，導致字幕管線複用舊視頻字幕。
    document.dispatchEvent(new CustomEvent('ai-trans:video-changed'));
    diagLog('content', 'Dispatched ai-trans:video-changed event to MAIN world interceptor');
    this.urlChangeTimer = setTimeout(() => {
      this.urlChangeTimer = null;
      diagLog('content', 'restart() starting after URL change');
      // §5.5/R6：SPA 換視頻後重啟失敗必須落診斷，不許靜默。
      void this.restart().then(() => {
        diagLog('content', 'restart() completed successfully');
      }).catch((err) => {
        diagLog('content', 'restart() failed:', err instanceof Error ? err.message : String(err));
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'platform',
            code: 'spa-navigation-restart-failed',
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err)),
          },
        });
      });
    }, 300);
  }

  /**
   * Patch history.pushState/replaceState，捕獲 SPA 換視頻導航（R4 需可解除）。
   * 返回是否成功 patch（patch 失敗時僅靠 popstate 兜底）。
   */
  private patchHistoryApi(): boolean {
    try {
      // R1：宿主方法必須綁定接收者——調用原始 pushState 需以 history 為接收者。
      history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
        this.origPushState.call(history, data, unused, url);
        // 同步觸發 URL 變化檢查（YouTube pushState 後 location.href 已更新）。
        this.onUrlChanged();
      }) as typeof history.pushState;
      history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
        this.origReplaceState.call(history, data, unused, url);
        this.onUrlChanged();
      }) as typeof history.replaceState;
      return true;
    } catch (err) {
      // §5.6：patch 失敗（嚴格模式拒絕改只讀屬性等）不靜默——留麵包屑，popstate 仍兜底。
      console.warn('[AI_Trans] SPA navigation patch failed, falling back to popstate only:', err);
      return false;
    }
  }

  private onEvent(e: PipelineEvent): void {
    if (e.type === 'segments-ready' || e.type === 'segments-updated') {
      diagLog('content', 'onEvent received', e.type, 'with', e.segments.length, 'segments');
      this.cues = e.segments.map((s) => ({
        id: s.id,
        sourceText: s.sourceText,
        translatedText: s.translatedText ?? s.sourceText,
        provisional: s.provisional,
        start: s.start,
        end: s.end,
      }));
      // D3：記錄 playback vs coverage gap（正值 = 翻譯落後播放位置，負值 = 翻譯超前）。
      if (this.cues.length > 0) {
        const maxEnd = Math.max(...this.cues.map(c => c.end));
        const gap = this.currentTime - maxEnd;
        diagLog('content', 'playback-cue gap:', gap, 'ms (currentTime:', this.currentTime, 'maxEnd:', maxEnd, ')', gap > 0 ? 'BEHIND' : 'AHEAD');
      }
      // M2-24 補充修復十四：字幕成功接管後解除晚捕獲等待（不再需要重試）。
      this.lateCaptureRetry.disarm();
      diagLog('content', 'cues updated, count:', this.cues.length, 'calling scheduleDraw');
      this.scheduleDraw();
      return;
    }
    // M2-24 補充修復十四：全鏈無策略接管（含 native 捕獲晚到/超時）時，
    // 置位晚捕獲重試等待——pot 捕獲常晚於 15s 窗口到達，需等後續捕獲到達再重試。
    if (e.type === 'pipeline-error' && e.error.code === 'no-caption-strategy') {
      const videoId = extractVideoId(this.currentUrl());
      this.lateCaptureRetry.arm(videoId || null);
      diagLog('content', 'no-caption-strategy: arming late-capture retry for videoId:', videoId);
    }
    diagLog('content', 'onEvent received', e.type, e.type === 'engine-degraded' ? e.reason : '');
    // 降級/錯誤事件：持久化診斷 + console 麵包屑，讓「字幕沒出來」的原因可被用戶查詢。
    // 異步寫入不阻塞事件處理；recordDiagnostic 內部已 try/catch 守護（§5.7）。
    void recordDiagnostic(e);
  }

  /**
   * M2-24 補充修復十四：bridge 捕獲到**新** timedtext 響應。
   * 管線因 native 捕獲晚到而降級（no-caption-strategy）時，捕獲最終到達即為重試信號：
   * 同一視頻 + 未達上限 + 未在冷卻內 → 輕量重跑 Orchestrator（重新跑策略鏈），
   * native 的 fetchTracks→tryReuseCapture 會立刻命中該晚捕獲（bridge 保留 latest）。
   * 守衛：videoId 比對、重試上限、冷卻、segments-ready 解除（見 onEvent/stop）。
   */
  private onBridgeCapture(capture: TimedTextCapture): void {
    // 狀態機判定：未置位 / 視頻不匹配 / 達上限 / 在冷卻內 → 不重試。
    const attempt = this.lateCaptureRetry.onCapture(capture);
    if (attempt === null) return;
    // 調試輔助：暴露晚捕獲重試計數與捕獲到達延遲（no-caption 置位 → 捕獲到達），
    // 供真實環境確認機制生效與 pot 捕獲晚到程度（§5.6 留痕）。
    Reflect.set(globalThis, '__aiTransLateCaptureRetries', attempt);
    Reflect.set(globalThis, '__aiTransCaptureLatencyMs', this.lateCaptureRetry.latencyMs);
    diagLog('content', 'onBridgeCapture: late capture arrived, retrying native strategy (attempt', attempt, '/', MAX_LATE_CAPTURE_RETRIES, ')');
    // §5.5/R6：異步重試失敗必須落診斷，不許未捕獲懸掛 Promise 靜默消失。
    void this.retryAfterLateCapture().catch((err) => {
      diagLog('content', 'retryAfterLateCapture failed:', err instanceof Error ? err.message : String(err));
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'platform',
          code: 'native-capture-late-retry',
          recoverable: true,
          cause: err instanceof Error ? err : new Error(String(err)),
        },
      });
    });
  }

  /** M2-24 補充修復十四：輕量重跑策略鏈（晚捕獲重試）。不重掛 overlay、不重讀配置。 */
  private async retryAfterLateCapture(): Promise<void> {
    if (!this.orchestrator) return;
    const url = this.currentUrl();
    diagLog('content', 'retryAfterLateCapture: re-running strategy chain for', url);
    // Orchestrator.start 內部先 stop() 再重建鏈（含 cleanups 清理，R4），
    // 重跑 native 策略時 tryReuseCapture 會命中 bridge.latest（晚捕獲）。
    await this.orchestrator.start(url);
    diagLog('content', 'retryAfterLateCapture: completed');
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
      'text-shadow': '0 0 4px #000, 0 0 2px #000',
      'background-color': this.config.subtitleStyle?.['background-color'] ?? 'rgba(32, 32, 32, 0.7)',
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
