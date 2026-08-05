"use strict";
(() => {
  // src/application/registry.ts
  function selectPlatform(registry, url) {
    return registry.platforms.find((p) => p.matches(url));
  }

  // src/application/caption-strategy-chain.ts
  var CaptionStrategyChain = class {
    constructor(strategies, onEvent) {
      this.strategies = strategies;
      this.onEvent = onEvent;
    }
    strategies;
    onEvent;
    /** 依序嘗試各策略，返回最終接管且成功執行的策略 origin。 */
    async runWithFallback(ctx) {
      const errors = [];
      for (const strategy of this.strategies) {
        try {
          const applicable = await strategy.isApplicable(ctx);
          if (!applicable) {
            errors.push({
              port: "platform",
              code: "strategy-not-applicable",
              recoverable: true
            });
            continue;
          }
          await strategy.run(ctx, (e) => {
            if (e.type === "strategy-degraded") {
              this.onEvent?.(e);
            }
            this.onEvent?.(e);
          });
          return { origin: strategy.origin, errors };
        } catch (err) {
          const next = this.strategies[this.strategies.indexOf(strategy) + 1];
          errors.push({
            port: "platform",
            code: "strategy-failed",
            recoverable: !!next,
            cause: err
          });
          if (next) {
            this.onEvent?.({
              type: "strategy-degraded",
              from: strategy.origin,
              to: next.origin
            });
          } else {
            return { origin: strategy.origin, errors };
          }
        }
      }
      return { origin: void 0, errors };
    }
    stopAll() {
      for (const s of this.strategies) s.stop();
    }
  };

  // src/application/translation-pipeline.ts
  var TranslationPipeline = class {
    constructor(opts) {
      this.opts = opts;
    }
    opts;
    location = "cloud";
    engineId = "pipeline";
    async translate(req) {
      const request = {
        ...req,
        targetLang: req.targetLang ?? this.opts.targetLang,
        streaming: this.opts.streaming
      };
      try {
        const result = await this.opts.primary.translate(request);
        if (result.degraded) {
          this.emit({
            type: "engine-degraded",
            port: "translation",
            reason: `engine ${result.engineId} reported degraded`
          });
        }
        return result;
      } catch (primaryErr) {
        if (this.opts.fallback) {
          this.emit({
            type: "engine-degraded",
            port: "translation",
            reason: `primary failed: ${String(primaryErr)}`
          });
          this.emitError(primaryErr);
          const result = await this.opts.fallback.translate(request);
          return {
            ...result,
            engineId: result.engineId,
            degraded: true,
            segments: result.segments.map((s) => ({
              ...s,
              translatedText: s.translatedText ?? s.sourceText
            }))
          };
        }
        throw primaryErr;
      }
    }
    async translateStream(req, emit) {
      const request = {
        ...req,
        targetLang: req.targetLang ?? this.opts.targetLang,
        streaming: true
      };
      if (!this.opts.primary.translateStream) {
        const result = await this.translate(request);
        emit(result);
        return;
      }
      try {
        await this.opts.primary.translateStream(request, emit);
      } catch (primaryErr) {
        this.emit({
          type: "engine-degraded",
          port: "translation",
          reason: `primary stream failed: ${String(primaryErr)}`
        });
        this.emitError(primaryErr);
        const result = await this.translate(request);
        emit(result);
      }
    }
    emit(e) {
      this.opts.onEvent?.(e);
    }
    emitError(cause) {
      this.opts.onEvent?.({
        type: "pipeline-error",
        error: {
          port: "translation",
          code: "translation-failed",
          recoverable: !!this.opts.fallback,
          cause
        }
      });
    }
  };

  // src/application/orchestrator.ts
  var NoopASR = class _NoopASR {
    static instance = new _NoopASR();
    engineId = "noop";
    location = "local";
    async warmup() {
    }
    async transcribe() {
      throw new Error("ASR not enabled");
    }
  };
  var Orchestrator = class {
    constructor(deps, onEvent) {
      this.deps = deps;
      this.onEvent = onEvent;
    }
    deps;
    onEvent;
    chain = null;
    currentPlatformId = null;
    cleanups = [];
    lastPlayback = {
      currentTime: 0,
      playing: false,
      rate: 1,
      duration: 0,
      buffered: []
    };
    /** 在給定頁面啟動翻譯字幕流程。 */
    async start(url) {
      this.stop();
      const platform = selectPlatform(this.deps.registry, url);
      if (!platform) {
        this.onEvent({
          type: "engine-degraded",
          port: "translation",
          reason: `no platform adapter matches ${url}`
        });
        return;
      }
      this.currentPlatformId = platform.platformId;
      const config = await this.deps.getConfig();
      const primary = this.deps.registry.translation.get(
        config.translation.type === "cloud-llm" ? "llm" : config.translation.type === "local" ? "local-llm" : "mt"
      );
      const fallback = config.translation.fallbackType === "mt" ? this.deps.registry.translation.get("mt") : void 0;
      if (!primary) {
        this.onEvent({
          type: "engine-degraded",
          port: "translation",
          reason: `primary translation engine "${config.translation.type}" not registered`
        });
        return;
      }
      const translationPipeline = new TranslationPipeline({
        primary,
        fallback,
        targetLang: config.targetLang,
        streaming: config.performanceProfile === "streaming",
        onEvent: this.onEvent
      });
      const asrProvider = this.deps.enableAsr ? this.deps.registry.asr.get("asr") ?? NoopASR.instance : NoopASR.instance;
      const unsubscribe = platform.observePlayback((state) => {
        this.lastPlayback = state;
      });
      this.cleanups.push(unsubscribe);
      const ctx = {
        platform,
        playback: () => this.lastPlayback,
        config,
        asr: asrProvider,
        translation: translationPipeline
      };
      this.chain = new CaptionStrategyChain(
        this.deps.registry.strategies,
        this.onEvent
      );
      await this.chain.runWithFallback(ctx);
    }
    /** 停止當前策略與資源。 */
    stop() {
      this.chain?.stopAll();
      this.chain = null;
      this.currentPlatformId = null;
      for (const cleanup of this.cleanups) cleanup();
      this.cleanups.length = 0;
    }
    get platformId() {
      return this.currentPlatformId;
    }
  };

  // src/application/strategies/native-caption-strategy.ts
  var NativeCaptionStrategy = class {
    origin = "native";
    stopped = false;
    async isApplicable(ctx) {
      try {
        const tracks = await ctx.platform.listCaptionTracks();
        return tracks.length > 0;
      } catch {
        return false;
      }
    }
    async run(ctx, emit) {
      this.stopped = false;
      const tracks = await ctx.platform.listCaptionTracks();
      const track = tracks[0];
      if (!track) {
        emit({
          type: "engine-degraded",
          port: "translation",
          reason: "no caption track available"
        });
        return;
      }
      const segments = await track.fetch();
      if (this.stopped) return;
      const result = await ctx.translation.translate({
        segments,
        targetLang: ctx.config.targetLang
      });
      if (this.stopped) return;
      emit({ type: "segments-ready", segments: result.segments });
    }
    stop() {
      this.stopped = true;
    }
  };

  // src/application/strategies/lookahead-asr-strategy.ts
  var LookAheadASRStrategy = class {
    origin = "lookahead-asr";
    async isApplicable(_ctx) {
      return false;
    }
    async run(_ctx, _emit) {
    }
    stop() {
    }
  };

  // src/application/strategies/realtime-asr-strategy.ts
  var RealtimeASRStrategy = class {
    origin = "realtime-asr";
    async isApplicable(_ctx) {
      return false;
    }
    async run(_ctx, _emit) {
    }
    stop() {
    }
  };

  // src/adapters/platform/youtube/timedtext.ts
  function parseTimedText(raw, lang) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      return parseJson(trimmed, lang);
    }
    return parseXml(trimmed, lang);
  }
  function parseJson(raw, lang) {
    const doc = JSON.parse(raw);
    if (!Array.isArray(doc.events)) {
      throw new Error("timedtext JSON: missing events array");
    }
    return doc.events.map((ev, i) => {
      const text = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
      if (!text) return null;
      const start2 = Math.round(ev.tStartMs ?? 0);
      const dur = Math.round(ev.dDurationMs ?? 2e3);
      return toSegment(String(i), start2, start2 + dur, text, lang);
    }).filter((s) => s !== null);
  }
  function parseXml(raw, lang) {
    const doc = new DOMParser().parseFromString(raw, "application/xml");
    const transcribe = doc.getElementsByTagName("transcript")[0] ?? doc.getElementsByTagName("timedtext")[0];
    if (!transcribe) {
      throw new Error("timedtext XML: missing transcript root");
    }
    const nodes = transcribe.children;
    const segments = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.tagName !== "text") continue;
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      const start2 = Number(node.getAttribute("start") ?? 0);
      const dur = Number(node.getAttribute("dur") ?? 2);
      segments.push(
        toSegment(String(i), Math.round(start2 * 1e3), Math.round((start2 + dur) * 1e3), text, lang)
      );
    }
    return segments;
  }
  function toSegment(id, start2, end, text, lang) {
    return {
      id,
      start: start2,
      end,
      sourceText: text,
      sourceLang: lang,
      targetLang: void 0,
      origin: "native",
      provisional: false,
      revision: 0
    };
  }
  function createLazyCaptionTrack(lang, isAutoGenerated, loader) {
    return {
      lang,
      isAutoGenerated,
      fetch: loader
    };
  }

  // src/adapters/platform/youtube/platform-adapter.ts
  var YT_WATCH_RE = /^https:\/\/(www\.)?youtube\.com\/watch\?/;
  var FetchCaptionSource = class {
    doc;
    fetchFn;
    constructor(doc = globalThis.document, fetchFn = globalThis.fetch) {
      this.doc = doc;
      this.fetchFn = fetchFn === globalThis.fetch ? fetchFn.bind(globalThis) : fetchFn;
    }
    async fetchTrackList() {
      const json = this.findPlayerResponseJson();
      if (!json) return [];
      let data;
      try {
        data = JSON.parse(json);
      } catch {
        return [];
      }
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      return tracks.map((t) => ({
        lang: String(t.languageCode ?? "und"),
        baseUrl: String(t.baseUrl ?? ""),
        isAutoGenerated: Boolean(t.kind === "asr")
      }));
    }
    /** 從頁面內嵌腳本提取 ytInitialPlayerResponse JSON 文本；找不到返回 undefined。 */
    findPlayerResponseJson() {
      const named = this.doc.querySelector("script#ytInitialPlayerResponse")?.textContent;
      if (named && named.trim()) return named.trim();
      const scripts = this.doc.querySelectorAll("script:not([src])");
      for (const el of Array.from(scripts)) {
        const text = el.textContent ?? "";
        const m = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
        if (m) return m[1];
        const trimmed = text.trim();
        if (trimmed.startsWith("{") && trimmed.includes("captionTracks")) return trimmed;
      }
      return void 0;
    }
    async fetchTracks(baseUrl, lang) {
      const url = new URL(baseUrl, globalThis.location?.href ?? baseUrl).href;
      const res = await this.fetchFn(url, { credentials: "omit" });
      if (!res.ok) throw new Error(`timedtext fetch failed: ${res.status}`);
      const raw = await res.text();
      return parseTimedText(raw, lang);
    }
  };
  var YouTubePlatformAdapter = class {
    platformId = "youtube";
    constructor(opts = {}) {
      this.doc = opts.doc ?? globalThis.document;
      this.videoSelector = opts.videoSelector ?? "video.html5-main-video";
      this.playerSelector = opts.playerSelector ?? "div#movie_player, .html5-video-player";
      this.captionSource = opts.captionSource ?? new FetchCaptionSource(this.doc);
      this.watchUrlRe = opts.watchUrlRe ?? YT_WATCH_RE;
    }
    doc;
    videoSelector;
    playerSelector;
    captionSource;
    watchUrlRe;
    matches(url) {
      return this.watchUrlRe.test(url);
    }
    observePlayback(cb) {
      const video = this.doc.querySelector(this.videoSelector);
      if (!video) return () => {
      };
      const readState = () => ({
        currentTime: Math.round(video.currentTime * 1e3),
        playing: !video.paused && !video.ended,
        rate: video.playbackRate,
        duration: Math.round((video.duration || 0) * 1e3),
        buffered: Array.from({ length: video.buffered.length }, (_, i) => ({
          start: Math.round(video.buffered.start(i) * 1e3),
          end: Math.round(video.buffered.end(i) * 1e3)
        }))
      });
      const handler = () => cb(readState());
      const events = [
        "timeupdate",
        "play",
        "pause",
        "ratechange",
        "loadedmetadata",
        "progress"
      ];
      for (const ev of events) video.addEventListener(ev, handler);
      handler();
      return () => {
        for (const ev of events) video.removeEventListener(ev, handler);
      };
    }
    async listCaptionTracks() {
      const list = await this.captionSource.fetchTrackList();
      return list.map(
        (t) => createLazyCaptionTrack(
          t.lang,
          t.isAutoGenerated,
          () => this.captionSource.fetchTracks(t.baseUrl, t.lang)
        )
      );
    }
    async getAudioSource() {
      return {
        kind: "tab-capture",
        start: async () => {
          throw new Error("tabCapture not implemented (M2)");
        },
        stop: async () => {
        }
      };
    }
    mountPoint() {
      const player = this.doc.querySelector(this.playerSelector);
      if (!player) throw new Error("player mount point not found");
      return player;
    }
  };

  // src/adapters/translation/llm-translation.ts
  var LLMTranslationProvider = class {
    constructor(opts) {
      this.opts = opts;
      this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    }
    opts;
    location = "cloud";
    // R1：默認 fetch 必須綁定 globalThis，content-script 中裸 fetch 會拋 Illegal invocation。
    fetchFn;
    get engineId() {
      return this.opts.engineId;
    }
    async translate(req) {
      const lines = req.segments.map((s, i) => `${i}	${s.sourceText}`);
      const body = {
        model: this.opts.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `You are a subtitle translator. Translate each line to ${req.targetLang}. Keep the segment IDs as prefixes. Reply as "${req.targetLang}" text lines with the same IDs. Output one translated line per input line, format: "ID<TAB>translation".`
          },
          ...req.context?.length ? [{ role: "user", content: `Context: ${req.context.join("\n")}` }] : [],
          { role: "user", content: lines.join("\n") }
        ]
      };
      const res = await this.fetchFn(this.opts.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        throw new Error(`LLM translation failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      const map = /* @__PURE__ */ new Map();
      for (const line of content.split("\n")) {
        const m = /^(\d+)\t(.+)$/.exec(line.trim());
        if (m) map.set(m[1], m[2]);
      }
      const translated = req.segments.map((s, i) => ({
        ...s,
        translatedText: map.get(String(i)) ?? s.sourceText,
        targetLang: req.targetLang
      }));
      return { segments: translated, engineId: this.opts.engineId, degraded: false };
    }
  };

  // src/adapters/translation/mt-translation.ts
  var MTTranslationProvider = class {
    constructor(dict = {}) {
      this.dict = dict;
    }
    dict;
    location = "cloud";
    engineId = "mt";
    translate(req) {
      const segments = req.segments.map((s) => ({
        ...s,
        translatedText: this.replace(s.sourceText),
        targetLang: req.targetLang
      }));
      return Promise.resolve({
        segments,
        engineId: this.engineId,
        degraded: false
      });
    }
    replace(text) {
      return text.replace(/[A-Za-z]+/g, (w) => this.dict[w.toLowerCase()] ?? w);
    }
  };

  // src/adapters/render/overlay-renderer.ts
  var OverlayRenderer = class {
    root = null;
    style = {};
    cues = [];
    currentId = null;
    mount(container, style = {}) {
      this.style = style;
      const root = document.createElement("div");
      root.className = "ai-trans-overlay";
      const base = {
        position: "absolute",
        bottom: "12%",
        left: "50%",
        transform: "translateX(-50%)",
        "text-align": "center",
        "max-width": "90%",
        "pointer-events": "none",
        "z-index": "2147483647"
      };
      for (const [k, v] of Object.entries(base)) root.style.setProperty(k, v);
      for (const [k, v] of Object.entries(style)) {
        if (k === "display-mode") continue;
        root.style.setProperty(this.kebab(k), v);
      }
      container.appendChild(root);
      this.root = root;
    }
    render(cues, currentTime) {
      this.cues = cues;
      this.draw(currentTime);
    }
    updateProvisional(cue) {
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
    unmount() {
      this.root?.remove();
      this.root = null;
      this.currentId = null;
    }
    draw(currentTime) {
      const active = this.cues.find(
        (c) => currentTime >= c.start && currentTime < c.end
      );
      if (active) {
        this.currentId = active.id;
        this.renderActive(active);
      } else {
        this.clear();
      }
    }
    renderActive(cue) {
      if (!this.root) return;
      const bilingual = this.style["display-mode"] !== "mono";
      const parts = [];
      if (bilingual && cue.sourceText) {
        parts.push(`<span class="ai-trans-src">${escapeHtml(cue.sourceText)}</span>`);
      }
      parts.push(`<span class="ai-trans-dst">${escapeHtml(cue.translatedText)}</span>`);
      this.root.innerHTML = parts.join("<br/>");
      this.root.dataset.provisional = String(cue.provisional);
    }
    clear() {
      if (this.root) {
        this.root.innerHTML = "";
        this.currentId = null;
      }
    }
    kebab(k) {
      return k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    }
  };
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // src/runtime/composition.ts
  async function buildDefaultRegistry(config, opts) {
    const youtube = new YouTubePlatformAdapter({
      captionSource: new FetchCaptionSource(),
      watchUrlRe: opts.platformWatchRe
    });
    const translation = await buildTranslationProviders(config, opts.apiKeyStore);
    return {
      platforms: [youtube],
      strategies: [
        new NativeCaptionStrategy(),
        new LookAheadASRStrategy(),
        new RealtimeASRStrategy()
      ],
      asr: /* @__PURE__ */ new Map(),
      // M2 起註冊 ASRProvider
      translation,
      renderer: new OverlayRenderer()
    };
  }
  async function buildTranslationProviders(config, apiKeyStore) {
    const providers = /* @__PURE__ */ new Map();
    const tc = config.translation;
    const llm = await createLLM(tc, apiKeyStore);
    if (llm) providers.set(llm.engineId, llm);
    const mt = new MTTranslationProvider({
      // 演示字典；實際接入真實 MT 服務。
      hello: "\u4F60\u597D",
      world: "\u4E16\u754C",
      welcome: "\u6B61\u8FCE"
    });
    providers.set("mt", mt);
    return providers;
  }
  async function createLLM(tc, apiKeyStore) {
    if (tc.type !== "cloud-llm" && tc.type !== "local") return void 0;
    const endpoint = tc.endpoint ?? "https://api.openai.com/v1/chat/completions";
    const model = tc.model ?? "gpt-4o-mini";
    const apiKey = await apiKeyStore.getApiKey("llm") ?? "";
    return new LLMTranslationProvider({
      engineId: tc.type === "local" ? "local-llm" : "llm",
      endpoint,
      model,
      apiKey
    });
  }

  // src/domain/models/config.ts
  var DEFAULT_CONFIG = {
    translation: { type: "cloud-llm", fallbackType: "mt" },
    asr: { type: "local-whisper", modelTier: "base" },
    targetLang: "zh-Hant",
    displayMode: "bilingual",
    performanceProfile: "balanced"
  };

  // src/infrastructure/chrome-config-store.ts
  var ChromeStorageConfigStore = class _ChromeStorageConfigStore {
    static KEY = "engineConfig";
    static KEYS_KEY = "engineConfigKeys";
    async get() {
      const stored = await chrome.storage.local.get(_ChromeStorageConfigStore.KEY);
      const raw = stored[_ChromeStorageConfigStore.KEY];
      return this.merge(DEFAULT_CONFIG, raw ?? {});
    }
    async set(patch) {
      const current = await this.get();
      const next = this.merge(current, patch);
      await chrome.storage.local.set({ [_ChromeStorageConfigStore.KEY]: next });
      for (const cb of this.subscribers) cb(next);
    }
    /** 讀取某引擎的 API 密鑰（獨立安全 key）。 */
    async getApiKey(slot) {
      const stored = await chrome.storage.local.get(_ChromeStorageConfigStore.KEYS_KEY);
      const keys = stored[_ChromeStorageConfigStore.KEYS_KEY] ?? {};
      return keys[slot];
    }
    /** 寫入某引擎的 API 密鑰。 */
    async setApiKey(slot, value) {
      const stored = await chrome.storage.local.get(_ChromeStorageConfigStore.KEYS_KEY);
      const keys = stored[_ChromeStorageConfigStore.KEYS_KEY] ?? {};
      keys[slot] = value;
      await chrome.storage.local.set({ [_ChromeStorageConfigStore.KEYS_KEY]: keys });
    }
    subscribe(cb) {
      this.subscribers.add(cb);
      return () => this.subscribers.delete(cb);
    }
    subscribers = /* @__PURE__ */ new Set();
    merge(base, patch) {
      return {
        ...base,
        ...patch,
        translation: { ...base.translation, ...patch.translation ?? {} },
        asr: { ...base.asr, ...patch.asr ?? {} }
      };
    }
  };

  // src/runtime/content-script.ts
  var PLAYER_SELECTOR = "div#movie_player, .html5-video-player, #mock-player";
  var MOUNT_WAIT_TIMEOUT_MS = 15e3;
  var store = new ChromeStorageConfigStore();
  var SubtitleController = class {
    constructor(config, url) {
      this.config = config;
      this.url = url;
      this.unsubscribeConfig = store.subscribe(() => {
        void this.restart();
      });
    }
    config;
    renderer = new OverlayRenderer();
    cues = [];
    currentTime = 0;
    mounted = false;
    orchestrator = null;
    rafId = 0;
    url;
    // R4：所有需解除的訂閱句柄，restart/stop 前必須全部清理，避免線性累積。
    unsubscribePlayback = null;
    unsubscribeConfig = null;
    pendingMountObserver = null;
    mountWaitTimer = null;
    /** 加載配置 → 組裝 → 掛載 → 啟動 Orchestrator。 */
    async start() {
      await this.ensureMounted();
      const isMockHost = /^https?:\/\/localhost(:\d+)?\//.test(this.url);
      const platformWatchRe = isMockHost ? /^https?:\/\/localhost(:\d+)?\// : void 0;
      const registry = await buildDefaultRegistry(this.config, {
        apiKeyStore: store,
        platformWatchRe
      });
      this.orchestrator = new Orchestrator(
        { registry, getConfig: () => store.get(), enableAsr: false },
        (e) => this.onEvent(e)
      );
      const platform = registry.platforms[0];
      if (!platform) {
        this.onEvent({
          type: "pipeline-error",
          error: {
            port: "platform",
            code: "no-platform-adapter",
            recoverable: false,
            cause: new Error("registry.platforms is empty")
          }
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
    async restart() {
      this.stop();
      this.config = await store.get();
      await this.start();
    }
    stop() {
      cancelAnimationFrame(this.rafId);
      this.pendingMountObserver?.disconnect();
      this.pendingMountObserver = null;
      if (this.mountWaitTimer !== null) {
        clearTimeout(this.mountWaitTimer);
        this.mountWaitTimer = null;
      }
      this.unsubscribePlayback?.();
      this.unsubscribePlayback = null;
      this.orchestrator?.stop();
      this.orchestrator = null;
      this.renderer.unmount();
      this.mounted = false;
      this.cues = [];
    }
    /** 徹底銷毀：解除配置訂閱（頁面卸載/SPA 導航離開時調用）。 */
    dispose() {
      this.stop();
      this.unsubscribeConfig?.();
      this.unsubscribeConfig = null;
    }
    onEvent(e) {
      if (e.type === "segments-ready" || e.type === "segments-updated") {
        this.cues = e.segments.map((s) => ({
          id: s.id,
          sourceText: s.sourceText,
          translatedText: s.translatedText ?? s.sourceText,
          provisional: s.provisional,
          start: s.start,
          end: s.end
        }));
        this.scheduleDraw();
      }
    }
    /** 播放器就緒後自動掛載覆蓋層；未就緒時等待 DOM 出現（YouTube 播放器異步加載）。 */
    async ensureMounted() {
      if (!document.querySelector(PLAYER_SELECTOR)) {
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.pendingMountObserver?.disconnect();
            this.pendingMountObserver = null;
            if (this.mountWaitTimer !== null) {
              clearTimeout(this.mountWaitTimer);
              this.mountWaitTimer = null;
            }
            resolve();
          };
          const mo = new MutationObserver(() => {
            if (document.querySelector(PLAYER_SELECTOR)) finish();
          });
          this.pendingMountObserver = mo;
          mo.observe(document.body, { childList: true, subtree: true });
          this.mountWaitTimer = setTimeout(finish, MOUNT_WAIT_TIMEOUT_MS);
        });
      }
      this.mountOverlay();
    }
    mountOverlay() {
      const player = document.querySelector(PLAYER_SELECTOR);
      if (!player || this.mounted) return;
      this.renderer.mount(player, {
        "font-size": this.config.subtitleStyle?.["font-size"] ?? "24px",
        color: this.config.subtitleStyle?.color ?? "#fff",
        "text-shadow": "0 1px 3px rgba(0,0,0,.8)",
        "background-color": this.config.subtitleStyle?.["background-color"] ?? "transparent",
        "display-mode": this.config.displayMode
      });
      this.mounted = true;
    }
    /** rAF 對齊：避免每幀重排，僅在時間跨段時重繪。 */
    scheduleDraw() {
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(() => {
        if (this.mounted) this.renderer.render(this.cues, this.currentTime);
      });
    }
  };
  async function start() {
    const config = await store.get();
    const controller = new SubtitleController(config, window.location.href);
    await controller.start();
  }
  void start();
})();

