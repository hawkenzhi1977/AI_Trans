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
      const diagnostics = [];
      const ctxWithDiag = { ...ctx, diagnostics };
      for (const strategy of this.strategies) {
        try {
          const applicable = await strategy.isApplicable(ctxWithDiag);
          if (!applicable) {
            errors.push({
              port: "platform",
              code: "strategy-not-applicable",
              recoverable: true
            });
            continue;
          }
          await strategy.run(ctxWithDiag, (e) => {
            if (e.type === "strategy-degraded") {
              this.onEvent?.(e);
            }
            this.onEvent?.(e);
          });
          return { origin: strategy.origin, errors };
        } catch (err) {
          const next = this.strategies[this.strategies.indexOf(strategy) + 1];
          const causeMsg = err instanceof Error ? err.message : String(err);
          diagnostics.push(`${strategy.origin}: run failed \u2014 ${causeMsg}`);
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
      if (this.onEvent) {
        const reason = diagnostics.length > 0 ? diagnostics.join(" | ") : "all caption strategies not applicable (no captions found)";
        this.onEvent({
          type: "pipeline-error",
          error: {
            port: "platform",
            code: "no-caption-strategy",
            recoverable: false,
            cause: new Error(reason)
          }
        });
      }
      return { origin: void 0, errors };
    }
    stopAll() {
      for (const s of this.strategies) s.stop();
    }
    /** 傳播 seek 事件到各策略（僅原生字幕策略需要重新優先化翻譯隊列）。 */
    onSeek(currentTimeMs) {
      for (const s of this.strategies) {
        s.onSeek?.(currentTimeMs);
      }
    }
  };

  // src/domain/models/config.ts
  var LOCAL_ONNX_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";
  var DEFAULT_LOCAL_TRANSLATION_MODEL = LOCAL_ONNX_MODEL;
  var DEBUG_LOG_OFF = {
    overlay: false,
    llm: false,
    capture: false,
    pipeline: false,
    strategy: false,
    content: false,
    bridge: false,
    interceptor: false,
    "local-onnx": false,
    popup: false
  };
  var DEFAULT_CONFIG = {
    enabled: true,
    translation: { type: "cloud-llm", fallbackType: "mt" },
    asr: { type: "local-whisper", modelTier: "base" },
    targetLang: "zh-Hant",
    displayMode: "bilingual",
    performanceProfile: "balanced",
    subtitleStyle: {
      "font-size": "24px",
      color: "#ffffff",
      "background-color": "rgba(32, 32, 32, 0.7)"
    },
    debugLog: DEBUG_LOG_OFF,
    falseSeekThresholdMs: 1e4
  };

  // src/infrastructure/debug-log.ts
  var flags = { ...DEBUG_LOG_OFF };
  function setDebugFlags(next) {
    flags = { ...DEBUG_LOG_OFF, ...next ?? {} };
  }
  function diagLog(category, ...args) {
    if (!flags[category]) return;
    console.log(`[AI_Trans:diag][${category}]`, ...args);
  }

  // src/application/translation-pipeline.ts
  var TranslationPipeline = class {
    constructor(opts) {
      this.opts = opts;
    }
    opts;
    location = "cloud";
    engineId = "pipeline";
    async translate(req) {
      diagLog("pipeline", "translate() called,", req.segments.length, "segments, targetLang:", req.targetLang ?? this.opts.targetLang);
      const request = {
        ...req,
        targetLang: req.targetLang ?? this.opts.targetLang,
        streaming: this.opts.streaming
      };
      try {
        diagLog("pipeline", "calling primary engine:", this.opts.primary.engineId);
        const result = await this.opts.primary.translate(request);
        diagLog("pipeline", "primary engine succeeded, degraded:", result.degraded);
        if (result.degraded) {
          this.emit({
            type: "engine-degraded",
            port: "translation",
            reason: `engine ${result.engineId} reported degraded`
          });
        }
        return result;
      } catch (primaryErr) {
        diagLog("pipeline", "primary engine FAILED:", String(primaryErr));
        const fallback = this.opts.fallback;
        if (fallback && fallback.engineId !== this.opts.primary.engineId) {
          diagLog("pipeline", "falling back to:", fallback.engineId);
          this.emit({
            type: "engine-degraded",
            port: "translation",
            reason: `primary failed: ${String(primaryErr)}`
          });
          this.emitError(primaryErr);
          const result = await fallback.translate(request);
          diagLog("pipeline", "fallback engine succeeded");
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
        if (fallback && fallback.engineId === this.opts.primary.engineId) {
          diagLog("pipeline", "skipping fallback: same engine as primary (", this.opts.primary.engineId, ")");
          this.emitError(primaryErr);
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
        if (primaryErr instanceof DOMException && primaryErr.name === "AbortError") {
          throw primaryErr;
        }
        this.emit({
          type: "engine-degraded",
          port: "translation",
          reason: `primary stream failed: ${String(primaryErr)}`
        });
        this.emitError(primaryErr);
        const fallback = this.opts.fallback;
        if (fallback && fallback.engineId !== this.opts.primary.engineId) {
          diagLog("pipeline", "translateStream failed, falling back to different engine:", fallback.engineId);
          const result = await fallback.translate(request);
          emit({
            ...result,
            engineId: result.engineId,
            degraded: true,
            segments: result.segments.map((s) => ({
              ...s,
              translatedText: s.translatedText ?? s.sourceText
            }))
          });
        } else {
          if (fallback && fallback.engineId === this.opts.primary.engineId) {
            diagLog("pipeline", "skipping fallback: same engine as primary (", this.opts.primary.engineId, ")");
          }
          throw primaryErr;
        }
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

  // src/infrastructure/vad.ts
  var DEFAULT_VAD_CONFIG = {
    threshold: 0.01,
    silenceDurationMs: 2e3
  };
  var EnergyVAD = class {
    config;
    silenceStartTime = null;
    constructor(config = {}) {
      this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    }
    /**
     * 處理音頻塊，返回 VAD 結果。
     * @param pcm 單聲道 PCM 數據（Float32Array，值域 -1 到 1）。
     * @param _sampleRate 採樣率（Hz，保留供未來擴展）。
     * @param timestamp 時間戳（毫秒，performance.now()）。
     */
    process(pcm, _sampleRate, timestamp) {
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) {
        sum += pcm[i] * pcm[i];
      }
      const rms = Math.sqrt(sum / pcm.length);
      const isSpeech = rms >= this.config.threshold;
      if (!isSpeech) {
        if (this.silenceStartTime === null) {
          this.silenceStartTime = timestamp;
        }
      } else {
        this.silenceStartTime = null;
      }
      return { isSpeech, rms };
    }
    /**
     * 檢測是否應觸發分段邊界（靜音持續超過閾值）。
     * @param timestamp 當前時間戳（毫秒）。
     * @returns 是否應切分音頻塊。
     */
    shouldSegment(timestamp) {
      if (this.silenceStartTime === null) return false;
      const silenceDuration = timestamp - this.silenceStartTime;
      return silenceDuration >= this.config.silenceDurationMs;
    }
    /** 重置靜音計數器（新音頻流開始時調用）。 */
    reset() {
      this.silenceStartTime = null;
    }
    /**
     * 標記 AudioChunk 的 isSpeech 字段（批量處理）。
     * @param chunk 待標記的音頻塊。
     * @returns 標記後的音頻塊（原地修改）。
     */
    markChunk(chunk) {
      const { isSpeech } = this.process(chunk.pcm, chunk.sampleRate, performance.now());
      chunk.isSpeech = isSpeech;
      return chunk;
    }
  };

  // src/infrastructure/perf/metrics.ts
  var PerfMetrics = class {
    /** 滑動窗口大小（樣本數）。 */
    windowSize;
    /** 樣本緩存（按 stage 分組）。 */
    samples = /* @__PURE__ */ new Map();
    constructor(windowSize = 100) {
      this.windowSize = windowSize;
    }
    /** 添加性能樣本。 */
    add(sample) {
      const stage = sample.stage;
      if (!this.samples.has(stage)) {
        this.samples.set(stage, []);
      }
      const list = this.samples.get(stage);
      list.push(sample);
      if (list.length > this.windowSize) {
        list.shift();
      }
    }
    /** 獲取指定階段的統計摘要。 */
    summary(stage) {
      const list = this.samples.get(stage);
      if (!list || list.length === 0) return null;
      const sorted = [...list].sort((a, b) => a.ms - b.ms);
      const p50Index = Math.floor(sorted.length * 0.5);
      const p95Index = Math.floor(sorted.length * 0.95);
      const rtfSamples = list.filter((s) => s.rtf !== void 0);
      const avgRtf = rtfSamples.length > 0 ? rtfSamples.reduce((sum, s) => sum + (s.rtf ?? 0), 0) / rtfSamples.length : 0;
      const maxRtf = rtfSamples.length > 0 ? Math.max(...rtfSamples.map((s) => s.rtf ?? 0)) : 0;
      return {
        count: list.length,
        p50: sorted[p50Index].ms,
        p95: sorted[p95Index].ms,
        avgRtf,
        maxRtf
      };
    }
    /** 獲取所有階段的統計摘要。 */
    allSummaries() {
      const result = /* @__PURE__ */ new Map();
      for (const stage of this.samples.keys()) {
        const summary = this.summary(stage);
        if (summary) result.set(stage, summary);
      }
      return result;
    }
    /** 重置所有統計。 */
    reset() {
      this.samples.clear();
    }
    /**
     * 檢測是否需要降檔（RTF > 1.0 持續超過閾值）。
     * @param thresholdMs 持續時間閾值（毫秒），默認 30000ms（30s）。
     * @returns 是否建議降檔。
     */
    shouldDowngrade(thresholdMs = 3e4) {
      const asrSummary = this.summary("asr");
      if (!asrSummary) return false;
      const asrSamples = this.samples.get("asr") ?? [];
      const highRtfCount = asrSamples.filter((s) => (s.rtf ?? 0) > 1).length;
      const highRtfRatio = highRtfCount / asrSamples.length;
      if (highRtfRatio > 0.5 && asrSamples.length >= 10) {
        const avgInterval = asrSamples.length > 1 ? (asrSamples[asrSamples.length - 1].seq - asrSamples[0].seq) / (asrSamples.length - 1) : 1;
        const estimatedDuration = asrSamples.length * avgInterval * 256;
        return estimatedDuration >= thresholdMs;
      }
      return false;
    }
  };

  // src/infrastructure/diagnostics.ts
  var DIAGNOSTIC_KEY = "lastDiagnostic";
  function extractDiagnostic(e) {
    switch (e.type) {
      case "engine-degraded":
        if (e.port === "translation" || e.port === "asr") {
          return { kind: "degraded", message: e.reason };
        }
        return void 0;
      case "pipeline-error":
        return { kind: "error", message: formatCause(e.error.cause) };
      default:
        return void 0;
    }
  }
  function formatCause(cause) {
    if (cause instanceof Error) {
      return `${cause.name}: ${cause.message}`;
    }
    return String(cause ?? "unknown error");
  }
  function isUserActionable(message) {
    const patterns = [
      // 網絡錯誤
      "Failed to fetch",
      "NetworkError",
      "CORS",
      "Mixed Content",
      "net::ERR_",
      // HTTP 狀態碼
      "401",
      "403",
      "404",
      "429",
      "500",
      "502",
      "503",
      "504",
      // 權限類
      "tab-capture-not-authorized",
      "not authorized",
      "permission",
      "access denied",
      // 配置類
      "model",
      "endpoint",
      "API key",
      "not found",
      "invalid"
    ];
    const lower = message.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }
  async function recordDiagnostic(e) {
    const diag = extractDiagnostic(e);
    if (!diag) return;
    const record = {
      kind: diag.kind,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message: diag.message,
      actionable: isUserActionable(diag.message)
    };
    console.warn(`[AI_Trans] translation degraded: ${diag.message}`);
    try {
      await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: record });
    } catch {
    }
  }

  // src/application/strategies/realtime-asr-strategy.ts
  var RealtimeASRStrategy = class {
    origin = "realtime-asr";
    deps = null;
    vad = null;
    perf = null;
    running = false;
    unsubscribeChunk = null;
    downgradeCheckInterval = null;
    audioHandle = null;
    /** 注入依賴（由 Orchestrator 調用）。 */
    inject(deps) {
      this.deps = deps;
      this.vad = new EnergyVAD({ threshold: deps.vadThreshold ?? 0.01 });
      this.perf = new PerfMetrics(100);
    }
    async isApplicable(ctx) {
      if (ctx.config.asr.type === "none") {
        ctx.diagnostics?.push?.("realtime-asr: ASR disabled (config.asr.type = none)");
        return false;
      }
      try {
        const authState = await chrome.storage.local.get("tabCaptureAuthorized");
        if (!authState.tabCaptureAuthorized) {
          ctx.diagnostics?.push?.("realtime-asr: tabCapture not authorized");
          return false;
        }
      } catch {
      }
      if (!this.deps) {
        ctx.diagnostics?.push?.("realtime-asr: dependencies not injected");
        return false;
      }
      return true;
    }
    async run(ctx, emit) {
      if (!this.deps || !this.vad || !this.perf) {
        throw new Error("RealtimeASRStrategy: dependencies not injected");
      }
      const { audioSource, asrProvider, translationProvider } = this.deps;
      this.running = true;
      this.downgradeCheckInterval = setInterval(() => {
        if (this.perf?.shouldDowngrade(3e4)) {
          recordDiagnostic({
            type: "engine-degraded",
            port: "asr",
            reason: "ASR performance degraded: RTF > 1.0 for 30s. Consider switching to cloud ASR or lower model tier."
          });
          emit({
            type: "engine-degraded",
            port: "asr",
            reason: "RTF > 1.0 for 30s, recommend downgrade"
          });
        }
      }, 1e4);
      this.audioHandle = await audioSource.open(ctx.platform);
      await this.audioHandle.start();
      audioSource.onChunk(async (chunk) => {
        if (!this.running) return;
        this.vad.markChunk(chunk);
        if (!chunk.isSpeech) return;
        try {
          const req = {
            chunk,
            hintLang: void 0,
            // 由配置驅動。
            allowPartial: true
          };
          const asrStartTime = performance.now();
          if (asrProvider.transcribeStream) {
            await asrProvider.transcribeStream(req, async (asrResult) => {
              const asrMs = performance.now() - asrStartTime;
              this.perf?.add({
                stage: "asr",
                ms: asrMs,
                seq: chunk.seq,
                rtf: asrResult.rtf
              });
              if (!this.running) return;
              emit({
                type: "metrics",
                data: { stage: "asr", ms: asrMs, seq: chunk.seq, rtf: asrResult.rtf }
              });
              const translateStart = performance.now();
              const translatedSegments = await this.translateSegments(
                asrResult.segments,
                translationProvider
              );
              const translateMs = performance.now() - translateStart;
              this.perf?.add({ stage: "translate", ms: translateMs, seq: chunk.seq });
              if (!this.running) return;
              emit({
                type: "metrics",
                data: { stage: "translate", ms: translateMs, seq: chunk.seq }
              });
              if (!this.running) return;
              emit({
                type: asrResult.isPartial ? "segments-updated" : "segments-ready",
                segments: translatedSegments
              });
            });
          } else {
            const asrResult = await asrProvider.transcribe(req);
            if (!this.running) return;
            const asrMs = performance.now() - asrStartTime;
            this.perf?.add({
              stage: "asr",
              ms: asrMs,
              seq: chunk.seq,
              rtf: asrResult.rtf
            });
            emit({
              type: "metrics",
              data: { stage: "asr", ms: asrMs, seq: chunk.seq, rtf: asrResult.rtf }
            });
            const translateStart = performance.now();
            const translatedSegments = await this.translateSegments(
              asrResult.segments,
              translationProvider
            );
            if (!this.running) return;
            const translateMs = performance.now() - translateStart;
            this.perf?.add({ stage: "translate", ms: translateMs, seq: chunk.seq });
            emit({
              type: "metrics",
              data: { stage: "translate", ms: translateMs, seq: chunk.seq }
            });
            if (!this.running) return;
            emit({
              type: "segments-ready",
              segments: translatedSegments
            });
          }
        } catch (err) {
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "asr",
              code: "asr-engine-failed",
              recoverable: true,
              cause: err instanceof Error ? err : new Error(String(err))
            }
          });
          if (!this.running) return;
          emit({
            type: "engine-degraded",
            port: "asr",
            reason: `ASR failed: ${err instanceof Error ? err.message : String(err)}`
          });
        }
      });
      this.unsubscribeChunk = () => {
      };
    }
    stop() {
      this.running = false;
      this.unsubscribeChunk?.();
      this.unsubscribeChunk = null;
      this.vad?.reset();
      if (this.downgradeCheckInterval !== null) {
        clearInterval(this.downgradeCheckInterval);
        this.downgradeCheckInterval = null;
      }
      if (this.audioHandle) {
        void this.audioHandle.stop().catch((err) => {
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "audio",
              code: "audio-handle-stop-failed",
              recoverable: true,
              cause: err instanceof Error ? err : new Error(String(err))
            }
          });
        });
        this.audioHandle = null;
      }
    }
    /** 翻譯字幕段（批量）。 */
    async translateSegments(segments, provider) {
      const result = await provider.translate({
        segments,
        targetLang: "zh-Hant"
      });
      return result.segments;
    }
    /** 獲取性能統計摘要（用於觀測與調試）。 */
    getPerfSummary() {
      return this.perf?.allSummaries() ?? null;
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
  var SEEK_THRESHOLD_MS = 1e4;
  var SEEK_DEBOUNCE_MS = 200;
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
    lastSeekDetectionTime = 0;
    seekDebounceTimer = null;
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
        config.translation.type === "local-onnx" ? "local-onnx" : config.translation.type === "cloud-llm" ? "llm" : config.translation.type === "local" ? "local-llm" : "mt"
      );
      let fallback;
      if (config.translation.fallbackType === "local-onnx") {
        fallback = this.deps.registry.translation.get("local-onnx");
      } else if (config.translation.fallbackType === "mt") {
        fallback = this.deps.registry.translation.get("mt");
      }
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
      if (primary.warmup) {
        void primary.warmup().catch((err) => {
          this.onEvent({
            type: "engine-degraded",
            port: "translation",
            reason: `Translation warmup failed: ${err instanceof Error ? err.message : String(err)}`
          });
        });
      }
      const asrProvider = this.deps.enableAsr ? this.deps.registry.asr.values().next().value ?? NoopASR.instance : NoopASR.instance;
      const realtimeStrategy = this.deps.registry.strategies.find(
        (s) => s instanceof RealtimeASRStrategy
      );
      if (realtimeStrategy && this.deps.enableAsr && asrProvider !== NoopASR.instance) {
        const audioSource = this.deps.registry.audioSources.get("tab-capture");
        if (audioSource) {
          realtimeStrategy.inject({
            audioSource,
            asrProvider,
            translationProvider: translationPipeline,
            vadThreshold: config.asr.vadThreshold
          });
          void asrProvider.warmup(config.asr).catch((err) => {
            this.onEvent({
              type: "engine-degraded",
              port: "asr",
              reason: `ASR warmup failed: ${err instanceof Error ? err.message : String(err)}`
            });
          });
        }
      }
      const unsubscribe = platform.observePlayback((state) => {
        const prevTime = this.lastPlayback.currentTime;
        this.lastPlayback = state;
        if (prevTime > 0 && Math.abs(state.currentTime - prevTime) > SEEK_THRESHOLD_MS) {
          this.lastSeekDetectionTime = state.currentTime;
          if (this.seekDebounceTimer !== null) clearTimeout(this.seekDebounceTimer);
          this.seekDebounceTimer = setTimeout(() => {
            this.seekDebounceTimer = null;
            this.chain?.onSeek(this.lastSeekDetectionTime);
          }, SEEK_DEBOUNCE_MS);
        }
      });
      this.cleanups.push(unsubscribe);
      const audioLanguage = platform.getAudioLanguage();
      const ctx = {
        platform,
        playback: () => this.lastPlayback,
        config,
        asr: asrProvider,
        translation: translationPipeline,
        audioLanguage
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
      if (this.seekDebounceTimer !== null) {
        clearTimeout(this.seekDebounceTimer);
        this.seekDebounceTimer = null;
      }
      this.lastSeekDetectionTime = 0;
    }
    get platformId() {
      return this.currentPlatformId;
    }
  };

  // src/application/late-capture-retry.ts
  var DEFAULT_MAX_RETRIES = 3;
  var DEFAULT_COOLDOWN_MS = 5e3;
  var LateCaptureRetry = class {
    awaiting = false;
    retryVideoId = null;
    retries = 0;
    armedAt = 0;
    lastRetryAt = 0;
    maxRetries;
    cooldownMs;
    nowFn;
    constructor(opts = {}) {
      this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
      this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      this.nowFn = opts.now ?? Date.now;
    }
    /** 是否正等待晚捕獲重試。 */
    get isAwaiting() {
      return this.awaiting;
    }
    /** 已執行的重試次數。 */
    get retryCount() {
      return this.retries;
    }
    /** 從置位到當前時間的延遲（毫秒；未置位返回 0）。 */
    get latencyMs() {
      return this.awaiting ? this.nowFn() - this.armedAt : 0;
    }
    /** 管線全鏈失敗（no-caption-strategy）時置位，開始等待晚捕獲。 */
    arm(videoId) {
      this.awaiting = true;
      this.retryVideoId = videoId || null;
      this.armedAt = this.nowFn();
    }
    /** 字幕成功接管（segments-ready）或停止/換視頻時解除，重置計數。 */
    disarm() {
      this.awaiting = false;
      this.retryVideoId = null;
      this.retries = 0;
      this.armedAt = 0;
      this.lastRetryAt = 0;
    }
    /**
     * 捕獲到達時調用：判定是否應觸發重試。
     * @returns 本次重試序號（1-based）；不應重試返回 null（未置位 / 視頻不匹配 / 達上限 / 在冷卻內）。
     */
    onCapture(capture) {
      if (!this.awaiting) return null;
      if (this.retryVideoId && capture.videoId && capture.videoId !== this.retryVideoId) {
        return null;
      }
      if (this.retries >= this.maxRetries) return null;
      const now = this.nowFn();
      if (this.retries > 0 && now - this.lastRetryAt < this.cooldownMs) return null;
      this.retries += 1;
      this.lastRetryAt = now;
      return this.retries;
    }
  };

  // src/application/strategies/native-caption-strategy.ts
  var WINDOW_START_OFFSET_ONNX_MS = 5e3;
  var WINDOW_START_OFFSET_DEFAULT_MS = 0;
  var WINDOW_END_OFFSET_MS = 12e4;
  function windowStartOffsetMs(translation) {
    return translation.type === "local-onnx" || translation.fallbackType === "local-onnx" ? WINDOW_START_OFFSET_ONNX_MS : WINDOW_START_OFFSET_DEFAULT_MS;
  }
  var NativeCaptionStrategy = class {
    origin = "native";
    stopped = false;
    allSegments = [];
    translatedIds = /* @__PURE__ */ new Set();
    accumulatedSegments = [];
    abortController = null;
    hasSeek = false;
    seekTime = 0;
    /** M2-36：存儲 ctx 供 onSeek() 訪問當前播放位置（虛假 seek 防護）。 */
    ctx = null;
    /**
     * 判斷是否有原生字幕軌可用。
     * 注意：listCaptionTracks 失敗/為空**不拋錯、返回 false**，交由鏈降級——
     * 但必須把原因記到 ctx 供鏈在「全鏈不適用」時發出可見診斷（§5.6 不靜默）。
     */
    async isApplicable(ctx) {
      try {
        const tracks = await ctx.platform.listCaptionTracks();
        if (tracks.length === 0) {
          const platformDiag = ctx.platform.getLastTrackDiagnostic?.();
          ctx.diagnostics?.push?.(`native: no caption tracks found \u2014 ${platformDiag ?? "no captions on page"}`);
        }
        return tracks.length > 0;
      } catch (err) {
        ctx.diagnostics?.push?.(
          `native: listCaptionTracks failed \u2014 ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
    }
    async run(ctx, emit) {
      this.stopped = false;
      this.ctx = ctx;
      const tracks = await ctx.platform.listCaptionTracks();
      const track = this.selectBestTrack(tracks, ctx);
      if (!track) {
        emit({
          type: "engine-degraded",
          port: "translation",
          reason: "no caption track available"
        });
        return;
      }
      diagLog("strategy", `selected track: ${track.lang} (reason: ${this.lastSelectionReason})`);
      diagLog("strategy", "track.fetch() starting");
      this.allSegments = await track.fetch();
      diagLog("strategy", "track.fetch() returned", this.allSegments.length, "segments");
      if (this.stopped) return;
      this.translatedIds.clear();
      this.accumulatedSegments = [];
      try {
        await this.translateWithPriority(ctx, emit);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (this.stopped) return;
        diagLog("strategy", "translation FAILED:", err instanceof Error ? err.message : String(err));
        emit({
          type: "engine-degraded",
          port: "translation",
          reason: `translation failed, falling back to original subtitles: ${err instanceof Error ? err.message : String(err)}`
        });
        const untranslated = this.allSegments.filter((s) => !this.translatedIds.has(s.id));
        const fallbackSegments = untranslated.map((s) => ({
          ...s,
          translatedText: s.sourceText,
          targetLang: s.sourceLang
        }));
        emit({ type: "segments-ready", segments: fallbackSegments });
      }
    }
    /**
     * 動態優先級翻譯循環：
      * 1. 按 currentTime+offset 為起點排序未翻譯 segments（滑動窗口優先；M1-59：ONNX +5s / 其他 +0s）
     * 2. 流式翻譯，每 chunk 完成即 emit 累計結果
     * 3. seek 時中斷當前翻譯，重新優先化後繼續
     */
    async translateWithPriority(ctx, emit) {
      let firstEmit = this.accumulatedSegments.length === 0;
      while (!this.stopped) {
        if (this.hasSeek) {
          this.hasSeek = false;
          diagLog("strategy", "seek detected at", this.seekTime, "ms, re-prioritizing");
        }
        const currentTime = this.seekTime || ctx.playback().currentTime;
        this.seekTime = 0;
        const prioritized = this.getPrioritizedSegments(currentTime, windowStartOffsetMs(ctx.config.translation));
        if (prioritized.length === 0) {
          diagLog("strategy", "all segments translated, total:", this.translatedIds.size);
          break;
        }
        diagLog(
          "strategy",
          "translation round starting, currentTime:",
          currentTime,
          "untranslated:",
          prioritized.length,
          "translated:",
          this.translatedIds.size,
          "first priority start:",
          prioritized[0]?.start
        );
        this.abortController = new AbortController();
        try {
          if (ctx.translation.translateStream) {
            await ctx.translation.translateStream(
              { segments: prioritized, targetLang: ctx.config.targetLang, signal: this.abortController.signal },
              (result) => {
                if (this.stopped) return;
                for (const seg of result.segments) {
                  if (!this.translatedIds.has(seg.id)) {
                    this.translatedIds.add(seg.id);
                  }
                }
                this.mergeAccumulated(result.segments);
                const sortedSegments = [...this.accumulatedSegments].sort((a, b) => a.start - b.start);
                const coverageStart = sortedSegments[0]?.start ?? 0;
                const coverageEnd = sortedSegments[sortedSegments.length - 1]?.end ?? 0;
                const currentPlaybackTime = ctx.playback().currentTime;
                const gap = currentPlaybackTime - coverageEnd;
                if (firstEmit) {
                  firstEmit = false;
                  diagLog(
                    "strategy",
                    "emit segments-ready at currentTime:",
                    currentPlaybackTime,
                    ", coverage:",
                    coverageStart,
                    "-",
                    coverageEnd,
                    "ms, gap:",
                    gap,
                    "ms",
                    gap > 0 ? "BEHIND" : "AHEAD"
                  );
                  emit({ type: "segments-ready", segments: sortedSegments });
                } else {
                  diagLog(
                    "strategy",
                    "emit segments-updated at currentTime:",
                    currentPlaybackTime,
                    ", coverage:",
                    coverageStart,
                    "-",
                    coverageEnd,
                    "ms, gap:",
                    gap,
                    "ms",
                    gap > 0 ? "BEHIND" : "AHEAD"
                  );
                  emit({ type: "segments-updated", segments: sortedSegments });
                }
              }
            );
          } else {
            const result = await ctx.translation.translate({
              segments: prioritized,
              targetLang: ctx.config.targetLang
            });
            for (const seg of result.segments) {
              this.translatedIds.add(seg.id);
            }
            this.mergeAccumulated(result.segments);
            const sortedSegments = [...this.accumulatedSegments].sort((a, b) => a.start - b.start);
            if (firstEmit) {
              firstEmit = false;
              emit({ type: "segments-ready", segments: sortedSegments });
            } else {
              emit({ type: "segments-updated", segments: sortedSegments });
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            diagLog("strategy", "translation aborted, will re-prioritize");
            continue;
          }
          throw err;
        }
        this.abortController = null;
      }
    }
    /**
     * 獲取按優先級排序的未翻譯 segments。
     * M1-59 滑動窗口 [currentTime+offset, currentTime+120s] 內的 segments 優先
     * （offset：ONNX +5s / 其他 +0s），窗口外的按時間順序排在後面。
     */
    getPrioritizedSegments(currentTime, offsetMs) {
      const untranslated = this.allSegments.filter((s) => !this.translatedIds.has(s.id));
      if (untranslated.length === 0) return [];
      const windowStart = currentTime + offsetMs;
      const windowEnd = currentTime + WINDOW_END_OFFSET_MS;
      const inWindow = untranslated.filter((s) => s.start >= windowStart && s.start <= windowEnd);
      const outWindow = untranslated.filter((s) => s.start < windowStart || s.start > windowEnd);
      inWindow.sort((a, b) => a.start - b.start);
      outWindow.sort((a, b) => a.start - b.start);
      return [...inWindow, ...outWindow];
    }
    /** 合併新翻譯的 segments 到累計結果（更新已存在的，添加新的）。 */
    mergeAccumulated(newSegments) {
      const existingMap = new Map(this.accumulatedSegments.map((s) => [s.id, s]));
      for (const seg of newSegments) {
        existingMap.set(seg.id, seg);
      }
      this.accumulatedSegments = Array.from(existingMap.values());
    }
    /** Seek 時由 Orchestrator 調用：中斷當前翻譯，記錄新位置。 */
    onSeek(currentTimeMs) {
      const threshold = this.ctx?.config.falseSeekThresholdMs ?? 1e4;
      if (currentTimeMs === 0 && this.ctx && this.ctx.playback().currentTime > threshold) {
        diagLog("strategy", "ignoring false seek to 0ms, actual position:", this.ctx.playback().currentTime, "threshold:", threshold);
        return;
      }
      this.hasSeek = true;
      this.seekTime = currentTimeMs;
      this.abortController?.abort();
    }
    /** M2-30：上次軌道選擇的原因（供診斷日誌）。 */
    lastSelectionReason = "";
    /**
     * M2-34：智能選擇最佳字幕軌道（簡化優先級）。
      * 優先級：
      * 1. 英文字幕（人工 > 自動，模糊匹配 en*）
      * 2. 音頻語言一致的字幕（人工 > 自動）— 僅當無英文字幕時
      * 3. 兜底：第一個軌道
      */
    selectBestTrack(tracks, ctx) {
      if (tracks.length === 0) return void 0;
      const audioLang = ctx.audioLanguage?.toLowerCase();
      const langMatches = (trackLang, target) => {
        const t = trackLang.toLowerCase();
        const tgt = target.toLowerCase();
        return t === tgt || t.startsWith(tgt + "-") || tgt.startsWith(t + "-");
      };
      const enManual = tracks.find((t) => langMatches(t.lang, "en") && !t.isAutoGenerated);
      if (enManual) {
        this.lastSelectionReason = "en-manual";
        return enManual;
      }
      const enAuto = tracks.find((t) => langMatches(t.lang, "en") && t.isAutoGenerated);
      if (enAuto) {
        this.lastSelectionReason = "en-auto";
        return enAuto;
      }
      if (audioLang) {
        const manualMatch = tracks.find((t) => langMatches(t.lang, audioLang) && !t.isAutoGenerated);
        if (manualMatch) {
          this.lastSelectionReason = `audio-match-manual (${audioLang})`;
          return manualMatch;
        }
        const autoMatch = tracks.find((t) => langMatches(t.lang, audioLang) && t.isAutoGenerated);
        if (autoMatch) {
          this.lastSelectionReason = `audio-match-auto (${audioLang})`;
          return autoMatch;
        }
      }
      this.lastSelectionReason = "fallback-first";
      return tracks[0];
    }
    stop() {
      this.stopped = true;
      this.abortController?.abort();
      this.ctx = null;
    }
  };

  // src/application/strategies/lookahead-asr-strategy.ts
  var LookAheadASRStrategy = class {
    origin = "lookahead-asr";
    async isApplicable(ctx) {
      ctx.diagnostics?.push?.("lookahead-asr: not implemented (M3)");
      return false;
    }
    async run(_ctx, _emit) {
    }
    stop() {
    }
  };

  // src/runtime/endpoint.ts
  function normalizeEndpoint(raw) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return "https://api.openai.com/v1/chat/completions";
    const base = trimmed.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  // src/adapters/platform/youtube/timedtext.ts
  function parseTimedText(raw, lang) {
    const trimmed = raw.trim();
    const isJson = trimmed.startsWith("{");
    diagLog(
      "capture",
      "parseTimedText: lang:",
      lang,
      "format:",
      isJson ? "json" : "xml",
      "length:",
      raw.length,
      "prefix:",
      snippet(raw, 120)
    );
    if (isJson) {
      return parseJson(trimmed, lang);
    }
    return parseXml(trimmed, lang);
  }
  function parseJson(raw, lang) {
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `timedtext JSON parse failed: ${err instanceof Error ? err.message : String(err)} \u2014 body snippet: ${snippet(raw, 80)}`
      );
    }
    if (!Array.isArray(doc.events)) {
      throw new Error("timedtext JSON: missing events array");
    }
    const firstEv = doc.events.find((e) => typeof e.tStartMs === "number");
    diagLog(
      "capture",
      "parseJson: events:",
      doc.events.length,
      "first tStartMs:",
      firstEv?.tStartMs,
      "first dDurationMs:",
      firstEv?.dDurationMs
    );
    const segments = doc.events.map((ev, i) => {
      const text = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
      if (!text) return null;
      const start2 = Math.round(ev.tStartMs ?? 0);
      const dur = Math.round(ev.dDurationMs ?? 2e3);
      return toSegment(String(i), start2, start2 + dur, text, lang);
    }).filter((s) => s !== null);
    logSegmentTimespan("parseJson", segments);
    return segments;
  }
  function parseXml(raw, lang) {
    const doc = new DOMParser().parseFromString(raw, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new Error(
        `timedtext XML: parse error (not valid XML) \u2014 root <${doc.documentElement?.tagName ?? "unknown"}>, body snippet: ${snippet(raw, 120)}`
      );
    }
    const timedtextRoot = doc.getElementsByTagName("timedtext")[0];
    if (timedtextRoot && timedtextRoot.getElementsByTagName("p").length > 0) {
      diagLog("capture", "parseXml: detected srv3 format (timedtext>p, t/d \u70BA\u6BEB\u79D2)");
      return parseSrv3(timedtextRoot, lang);
    }
    const transcribe = doc.getElementsByTagName("transcript")[0] ?? timedtextRoot;
    if (!transcribe) {
      throw new Error(
        `timedtext XML: missing transcript root \u2014 actual root <${doc.documentElement?.tagName ?? "none"}>, body snippet: ${snippet(raw, 120)}`
      );
    }
    const nodes = transcribe.children;
    const segments = [];
    diagLog(
      "capture",
      "parseXml: legacy format (transcript/text, start/dur \u70BA\u79D2\u2192\xD71000), root:",
      doc.documentElement?.tagName,
      "nodes:",
      nodes.length
    );
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.tagName !== "text") continue;
      const text = decodeEntities((node.textContent ?? "").trim());
      if (!text) continue;
      const start2 = Number(node.getAttribute("start") ?? 0);
      const dur = Number(node.getAttribute("dur") ?? 2);
      segments.push(
        toSegment(String(i), Math.round(start2 * 1e3), Math.round((start2 + dur) * 1e3), text, lang)
      );
    }
    logSegmentTimespan("parseXml(legacy)", segments);
    return segments;
  }
  function parseSrv3(root, lang) {
    const ps = root.getElementsByTagName("p");
    const segments = [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const text = decodeEntities((p.textContent ?? "").trim());
      if (!text) continue;
      const start2 = Number(p.getAttribute("t") ?? 0);
      const dur = Number(p.getAttribute("d") ?? 2e3);
      segments.push(
        toSegment(String(i), Math.round(start2), Math.round(start2 + dur), text, lang)
      );
    }
    logSegmentTimespan("parseXml(srv3)", segments);
    return segments;
  }
  function decodeEntities(s) {
    return s.replace(/&amp;#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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
  function logSegmentTimespan(source, segments) {
    if (segments.length === 0) {
      diagLog("capture", `${source}: 0 segments parsed`);
      return;
    }
    const starts = segments.map((s) => s.start);
    const ends = segments.map((s) => s.end);
    const durations = segments.map((s) => s.end - s.start);
    const minStart = Math.min(...starts);
    const maxStart = Math.max(...starts);
    const maxEnd = Math.max(...ends);
    const sortedDur = [...durations].sort((a, b) => a - b);
    const medianDur = sortedDur[Math.floor(sortedDur.length / 2)];
    const unitSuspicion = segments.length >= 50 && maxStart < 1e4 ? " \u2014 SUSPECT: timestamps may be seconds treated as ms (missing \xD71000)" : "";
    diagLog(
      "capture",
      `${source}: segments:`,
      segments.length,
      "start range:",
      minStart,
      "-",
      maxStart,
      "max end:",
      maxEnd,
      "median dur:",
      medianDur,
      "ms",
      unitSuspicion
    );
  }
  function createLazyCaptionTrack(lang, isAutoGenerated, loader) {
    return {
      lang,
      isAutoGenerated,
      fetch: loader
    };
  }
  function snippet(raw, n) {
    const clean = raw.replace(/[\t\r\n]+/g, " ").slice(0, n).trim();
    return clean.length > 0 ? `"${clean}"` : "(empty body)";
  }

  // src/adapters/platform/youtube/platform-adapter.ts
  var YT_WATCH_RE = /^https:\/\/(www\.)?youtube\.com\/watch\?/;
  var FetchCaptionSource = class {
    doc;
    fetchFn;
    captureProvider;
    /** 等待播放器捕獲響應的超時（毫秒）：視頻播放後播放器才發 timedtext 請求（M1-43）。 */
    waitForCaptureTimeoutMs;
    lastTrackDiagnostic;
    /** M2-30：視頻音頻語言（從 ytInitialPlayerResponse.videoDetails.audioLocale 提取）。 */
    cachedAudioLanguage;
    /** 從當前文檔 URL 提取視頻 ID（`v` 參數）；非 watch 頁或解析失敗返回空串。 */
    currentVideoId() {
      const href = this.doc.location?.href;
      if (!href) return "";
      try {
        return new URL(href).searchParams.get("v") ?? "";
      } catch {
        return "";
      }
    }
    constructor(doc = globalThis.document, fetchFn = globalThis.fetch, captureProvider, waitForCaptureTimeoutMs = 15e3) {
      this.doc = doc;
      this.fetchFn = fetchFn === globalThis.fetch ? fetchFn.bind(globalThis) : fetchFn;
      this.captureProvider = captureProvider;
      this.waitForCaptureTimeoutMs = waitForCaptureTimeoutMs;
    }
    getLastTrackDiagnostic() {
      return this.lastTrackDiagnostic;
    }
    /** M2-30：獲取視頻音頻語言（從 ytInitialPlayerResponse.videoDetails.audioLocale 提取）。 */
    getAudioLanguage() {
      return this.cachedAudioLanguage;
    }
    async fetchTrackList() {
      diagLog("capture", "fetchTrackList: starting, current URL:", this.doc.location?.href);
      const json = this.findPlayerResponseJson();
      if (!json) {
        this.lastTrackDiagnostic = "player response JSON not found (ytInitialPlayerResponse missing/empty)";
        diagLog("capture", "fetchTrackList: player response JSON not found");
        return [];
      }
      let data;
      try {
        data = JSON.parse(json);
      } catch (err) {
        this.lastTrackDiagnostic = `player response JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
        diagLog("capture", "fetchTrackList: JSON parse failed:", this.lastTrackDiagnostic);
        return [];
      }
      const currentVid = this.currentVideoId();
      const playerVid = data.videoDetails?.videoId ?? "";
      this.cachedAudioLanguage = data.videoDetails?.audioLocale;
      if (!this.cachedAudioLanguage && this.captureProvider?.getAudioLanguage) {
        this.cachedAudioLanguage = this.captureProvider.getAudioLanguage();
        if (this.cachedAudioLanguage) {
          diagLog("capture", "audioLocale not in player response, using interceptor-detected lang:", this.cachedAudioLanguage);
        }
      }
      if (!currentVid) {
        this.lastTrackDiagnostic = "not on watch page (no videoId in URL)";
        diagLog("capture", "fetchTrackList:", this.lastTrackDiagnostic);
        return [];
      }
      if (playerVid && currentVid !== playerVid) {
        this.lastTrackDiagnostic = `player response videoId mismatch: current=${currentVid}, player=${playerVid} (ytInitialPlayerResponse stale after SPA navigation)`;
        diagLog("capture", "fetchTrackList:", this.lastTrackDiagnostic);
        const fallbackTracks = this.getCaptionTracksFromPlayer();
        if (fallbackTracks.length > 0) {
          diagLog("capture", "fetchTrackList: fallback from player element succeeded, tracks:", fallbackTracks.length);
          return fallbackTracks;
        }
        const capturedTracks = this.getCaptionTracksFromBridge(currentVid);
        if (capturedTracks.length > 0) {
          diagLog("capture", "fetchTrackList: fallback from bridge captured tracks succeeded, tracks:", capturedTracks.length);
          return capturedTracks;
        }
        const waitedTracks = await this.waitForBridgeCapturedTracks(currentVid);
        if (waitedTracks.length > 0) {
          diagLog("capture", "fetchTrackList: waitForBridgeCapturedTracks succeeded, tracks:", waitedTracks.length);
          return waitedTracks;
        }
        return [];
      }
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (tracks.length === 0) {
        this.lastTrackDiagnostic = "player response has no captionTracks (video may have no captions)";
        diagLog("capture", "fetchTrackList: no captionTracks found");
      } else {
        this.lastTrackDiagnostic = void 0;
        diagLog("capture", "fetchTrackList: found", tracks.length, "tracks, first track baseUrl:", String(tracks[0].baseUrl ?? "").substring(0, 100));
      }
      return tracks.map((t) => ({
        lang: String(t.languageCode ?? "und"),
        baseUrl: String(t.baseUrl ?? ""),
        isAutoGenerated: Boolean(t.kind === "asr")
      }));
    }
    /** 從頁面內嵌腳本提取 ytInitialPlayerResponse JSON 文本；找不到返回 undefined。 */
    findPlayerResponseJson() {
      const named = this.doc.querySelector("script#ytInitialPlayerResponse")?.textContent;
      if (named && named.trim()) {
        diagLog("capture", "findPlayerResponseJson: found script#ytInitialPlayerResponse, length:", named.length);
        return named.trim();
      }
      const scripts = this.doc.querySelectorAll("script:not([src])");
      for (const el of Array.from(scripts)) {
        const text = el.textContent ?? "";
        const m = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
        if (m) {
          diagLog("capture", "findPlayerResponseJson: found ytInitialPlayerResponse assignment, length:", m[1].length);
          return m[1];
        }
        const trimmed = text.trim();
        if (trimmed.startsWith("{") && trimmed.includes("captionTracks")) {
          diagLog("capture", "findPlayerResponseJson: found inline JSON with captions, length:", trimmed.length);
          return trimmed;
        }
      }
      diagLog("capture", "findPlayerResponseJson: ytInitialPlayerResponse not found in any script");
      return void 0;
    }
    /**
     * M2-22：當 `ytInitialPlayerResponse` stale（SPA 導航後未更新）時，
     * 從播放器元素 API `getOption('captions', 'tracklist')` 獲取當前視頻的字幕軌。
     * 播放器 API 在 SPA 導航後會更新為新視頻的數據，是可靠的 fallback。
     */
    getCaptionTracksFromPlayer() {
      const player = this.doc.getElementById("movie_player");
      if (!player || typeof player.getOption !== "function") {
        diagLog("capture", "getCaptionTracksFromPlayer: player API not available");
        return [];
      }
      try {
        const raw = player.getOption("captions", "tracklist");
        if (!Array.isArray(raw) || raw.length === 0) {
          diagLog("capture", "getCaptionTracksFromPlayer: no tracks from player API");
          return [];
        }
        diagLog("capture", "getCaptionTracksFromPlayer: got", raw.length, "tracks from player API");
        return raw.map((t) => ({
          lang: String(t.languageCode ?? "und"),
          baseUrl: String(t.baseUrl ?? ""),
          isAutoGenerated: Boolean(t.kind === "asr")
        }));
      } catch (err) {
        diagLog("capture", "getCaptionTracksFromPlayer: error:", err instanceof Error ? err.message : String(err));
        return [];
      }
    }
    /**
     * M2-22 第三層：從 bridge 獲取 MAIN world 攔截器發現的軌道信息。
     * content script（isolated world）無法訪問 `movie_player.getOption()`，
     * 但 MAIN world 的攔截器可以。攔截器通過 postMessage 將軌道信息傳遞給 bridge，
     * 這裡從 bridge 讀取這些信息作為 fallback。
     */
    getCaptionTracksFromBridge(videoId) {
      if (!this.captureProvider?.getCapturedTracks) {
        diagLog("capture", "getCaptionTracksFromBridge: no getCapturedTracks provider");
        return [];
      }
      const tracks = this.captureProvider.getCapturedTracks(videoId);
      if (tracks.length === 0) {
        diagLog("capture", "getCaptionTracksFromBridge: no captured tracks for videoId:", videoId);
        return [];
      }
      diagLog("capture", "getCaptionTracksFromBridge: got", tracks.length, "tracks from bridge");
      return tracks.map((t) => ({
        lang: t.lang,
        baseUrl: t.baseUrl,
        isAutoGenerated: t.isAutoGenerated
      }));
    }
    /**
     * M2-22 第四層：等待 MAIN world 攔截器發現的軌道信息。
     * 當 bridge 尚未收到軌道信息時（攔截器發現 timedtext 請求需要時間），
     * 等待播放器發出請求並被攔截器發現，超時才放棄。
     */
    async waitForBridgeCapturedTracks(videoId) {
      if (!this.captureProvider?.waitForCapturedTracks) {
        diagLog("capture", "waitForBridgeCapturedTracks: no waitForCapturedTracks provider");
        return [];
      }
      diagLog("capture", "waitForBridgeCapturedTracks: waiting for tracks, videoId:", videoId);
      const tracks = await this.captureProvider.waitForCapturedTracks(this.waitForCaptureTimeoutMs, videoId);
      if (tracks.length === 0) {
        this.lastTrackDiagnostic = "bridge waitForCapturedTracks timeout (no timedtext request captured in time)";
        diagLog("capture", "waitForBridgeCapturedTracks: timeout, no tracks received");
        return [];
      }
      diagLog("capture", "waitForBridgeCapturedTracks: got", tracks.length, "tracks from bridge");
      return tracks.map((t) => ({
        lang: t.lang,
        baseUrl: t.baseUrl,
        isAutoGenerated: t.isAutoGenerated
      }));
    }
    async fetchTracks(baseUrl, lang) {
      diagLog("capture", "fetchTracks called, baseUrl:", baseUrl.substring(0, 100), "lang:", lang);
      let url;
      try {
        url = new URL(baseUrl, globalThis.location?.href ?? baseUrl).href;
      } catch (err) {
        throw new Error(
          `timedtext URL construct failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const finalUrl = this.withJson3Format(url);
      diagLog("capture", "fetchTracks: finalUrl after withJson3Format:", finalUrl.substring(0, 100));
      diagLog("capture", "fetchTracks: trying tryReuseCapture");
      const reused = this.tryReuseCapture(lang);
      if (reused) {
        diagLog("capture", "fetchTracks: reused capture success, segments:", reused.length);
        return reused;
      }
      diagLog("capture", "fetchTracks: no capture to reuse, trying waitForCaptureReuse");
      const waited = await this.waitForCaptureReuse(lang);
      if (waited) {
        diagLog("capture", "fetchTracks: waitForCaptureReuse success, segments:", waited.length);
        return waited;
      }
      diagLog("capture", "fetchTracks: waitForCaptureReuse timeout, falling back to direct fetch");
      let res;
      try {
        res = await this.fetchFn(finalUrl, { credentials: "include" });
      } catch (err) {
        const msg = `timedtext fetch failed: ${err instanceof Error ? err.message : String(err)} (url: ${finalUrl})`;
        this.lastTrackDiagnostic = msg;
        diagLog("capture", "fetchTracks: direct fetch failed:", msg);
        throw new Error(msg);
      }
      if (!res.ok) {
        const msg = `timedtext fetch HTTP ${res.status} (url: ${finalUrl})`;
        this.lastTrackDiagnostic = msg;
        diagLog("capture", "fetchTracks: direct fetch HTTP error:", msg);
        throw new Error(msg);
      }
      let raw;
      try {
        raw = await res.text();
      } catch (err) {
        const msg = `timedtext body read failed: ${err instanceof Error ? err.message : String(err)}`;
        this.lastTrackDiagnostic = msg;
        diagLog("capture", "fetchTracks: body read failed:", msg);
        throw new Error(msg);
      }
      try {
        const segments = parseTimedText(raw, lang);
        diagLog("capture", "fetchTracks: direct fetch success, segments:", segments.length);
        return segments;
      } catch (err) {
        const msg = `${err instanceof Error ? err.message : String(err)} (content-type: ${res.headers.get("content-type") ?? "unknown"})`;
        this.lastTrackDiagnostic = msg;
        diagLog("capture", "fetchTracks: parse failed:", msg);
        throw new Error(msg);
      }
    }
    /** 為真實 YouTube timedtext URL 追加 fmt=json3（Mock 相對路徑不動）。 */
    withJson3Format(url) {
      try {
        const u = new URL(url);
        if (u.hostname.endsWith("youtube.com") && u.pathname.includes("timedtext")) {
          u.searchParams.set("fmt", "json3");
          return u.href;
        }
        return url;
      } catch (err) {
        throw new Error(
          `timedtext URL parse failed in withJson3Format: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    /**
      * 嘗試複用 MAIN world 攔截器捕獲的播放器 timedtext 響應。
      * - 有捕獲值、響應非空 → 解析；解析失敗記診斷並回退（返回 undefined 讓 fetch 兜底）。
      * - 無捕獲值 → 返回 undefined（走等待或直接 fetch）。
      * 
      * M2-22：恢復 videoId 驗證——攔截器的 `lastCapture` 在 MAIN world，
      * `bridge.clearLatest()` 只清空 isolated world 的緩存，MAIN world 的 `lastCapture`
      * 仍可能保留舊視頻的捕獲（重播機制會持續發送）。必須驗證捕獲的 videoId 與當前視頻匹配。
      * 
      * M2-32：新增語言驗證——攔截器可能驅動了不同語言的軌道（如 es-ES），
      * 但策略選擇了另一語言（如 en）。複用前必須驗證捕獲 URL 的 lang 參數匹配請求語言。
      */
    tryReuseCapture(lang) {
      if (!this.captureProvider) {
        diagLog("capture", "tryReuseCapture: no captureProvider");
        return void 0;
      }
      const capture = this.captureProvider.getLatest();
      if (!capture || !capture.responseText) {
        diagLog("capture", "tryReuseCapture: no capture or empty responseText");
        return void 0;
      }
      const currentVid = this.currentVideoId();
      if (currentVid && capture.videoId && currentVid !== capture.videoId) {
        diagLog("capture", "tryReuseCapture: videoId mismatch, current:", currentVid, "capture:", capture.videoId, "- skipping stale capture");
        return void 0;
      }
      const captureLang = this.extractLangFromUrl(capture.url);
      if (captureLang && !this.langMatches(captureLang, lang)) {
        diagLog("capture", "tryReuseCapture: lang mismatch, capture:", captureLang, "request:", lang, "- skipping");
        return void 0;
      }
      diagLog("capture", "tryReuseCapture: found capture, url:", capture.url.substring(0, 80), "videoId:", capture.videoId);
      const { url, responseText, contentType } = capture;
      try {
        const segments = parseTimedText(responseText, lang);
        if (segments.length > 0) {
          this.lastTrackDiagnostic = `reused player timedtext capture (url: ${url})`;
          diagLog("capture", "tryReuseCapture: parse success, segments:", segments.length);
          return segments;
        }
        this.lastTrackDiagnostic = `timedtext capture parse empty (content-type: ${contentType}, url: ${url})`;
        diagLog("capture", "tryReuseCapture: parse empty, content-type:", contentType);
        return void 0;
      } catch (err) {
        this.lastTrackDiagnostic = `timedtext capture parse failed: ${err instanceof Error ? err.message : String(err)} (content-type: ${contentType}, url: ${url})`;
        diagLog("capture", "tryReuseCapture: parse failed:", this.lastTrackDiagnostic);
        return void 0;
      }
    }
    /**
      * 等待播放器捕獲響應後複用（M1-43）。
      * 僅當 provider 支持 waitForCapture 時等待；否則立即返回 undefined 走直接 fetch。
      * 
      * M2-22：傳入 expectedVideoId 確保只接受當前視頻的捕獲，避免 SPA 導航後複用 stale 捕獲。
      * 
      * M2-32：新增語言驗證——捕獲的 URL 語言必須匹配請求語言，否則跳過複用。
      */
    async waitForCaptureReuse(lang) {
      if (!this.captureProvider?.waitForCapture) {
        diagLog("capture", "waitForCaptureReuse: no waitForCapture provider");
        return void 0;
      }
      const expectedVideoId = this.currentVideoId();
      diagLog("capture", "waitForCaptureReuse: waiting for capture, timeout:", this.waitForCaptureTimeoutMs, "expectedVideoId:", expectedVideoId);
      let capture;
      try {
        capture = await this.captureProvider.waitForCapture(
          this.waitForCaptureTimeoutMs,
          expectedVideoId || void 0
        );
      } catch {
        this.lastTrackDiagnostic = `timedtext capture wait failed`;
        diagLog("capture", "waitForCaptureReuse: wait failed");
        return void 0;
      }
      if (!capture || !capture.responseText) {
        this.lastTrackDiagnostic = `timedtext capture wait timeout (${this.waitForCaptureTimeoutMs} ms) \u2014 fall back to direct fetch`;
        diagLog("capture", "waitForCaptureReuse: timeout, no capture received");
        return void 0;
      }
      const captureLang = this.extractLangFromUrl(capture.url);
      if (captureLang && !this.langMatches(captureLang, lang)) {
        diagLog("capture", "waitForCaptureReuse: lang mismatch, capture:", captureLang, "request:", lang, "- skipping");
        return void 0;
      }
      diagLog("capture", "waitForCaptureReuse: capture received, url:", capture.url.substring(0, 80), "videoId:", capture.videoId);
      try {
        const segments = parseTimedText(capture.responseText, lang);
        if (segments.length > 0) {
          this.lastTrackDiagnostic = `reused player timedtext capture after wait (url: ${capture.url})`;
          diagLog("capture", "waitForCaptureReuse: parse success, segments:", segments.length);
          return segments;
        }
        this.lastTrackDiagnostic = `timedtext capture parse empty (content-type: ${capture.contentType}, url: ${capture.url})`;
        diagLog("capture", "waitForCaptureReuse: parse empty");
        return void 0;
      } catch (err) {
        this.lastTrackDiagnostic = `timedtext capture parse failed: ${err instanceof Error ? err.message : String(err)} (content-type: ${capture.contentType}, url: ${capture.url})`;
        diagLog("capture", "waitForCaptureReuse: parse failed:", this.lastTrackDiagnostic);
        return void 0;
      }
    }
    /** M2-32：從 timedtext URL 提取 lang 參數。 */
    extractLangFromUrl(url) {
      try {
        return new URL(url).searchParams.get("lang") ?? void 0;
      } catch {
        return void 0;
      }
    }
    /** M2-32：模糊匹配語言（en 匹配 en-US、en-GB 等；zh 匹配 zh-Hant、zh-CN 等）。 */
    langMatches(a, b) {
      const al = a.toLowerCase(), bl = b.toLowerCase();
      return al === bl || al.startsWith(bl + "-") || bl.startsWith(al + "-");
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
      if (!video) {
        console.warn(
          `[AI_Trans] observePlayback: video element not found (selector: ${this.videoSelector})`
        );
        return () => {
        };
      }
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
        "progress",
        "seeked"
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
    getLastTrackDiagnostic() {
      return this.captionSource.getLastTrackDiagnostic?.();
    }
    /** M2-30：獲取視頻音頻語言（委托給 captionSource）。 */
    getAudioLanguage() {
      return this.captionSource.getAudioLanguage?.();
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
  var LLMRequestError = class extends Error {
    constructor(message, status, transient) {
      super(message);
      this.status = status;
      this.transient = transient;
      this.name = "LLMRequestError";
    }
    status;
    transient;
  };
  var CHUNK_SIZE = 15;
  var MAX_RETRIES = 2;
  var RETRY_DELAYS_MS = [500, 1500];
  var INCOMPLETE_MAX_RETRIES = 3;
  var INCOMPLETE_RETRY_DELAY_MS = 300;
  var DUPLICATE_MAX_RETRIES = 1;
  var CACHE_MAX_ENTRIES = 100;
  function djb2Hash(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) + hash + text.charCodeAt(i) | 0;
    }
    return (hash >>> 0).toString(16);
  }
  var LruCache = class {
    map = /* @__PURE__ */ new Map();
    get(key) {
      const hit = this.map.get(key);
      if (hit) {
        this.map.delete(key);
        this.map.set(key, hit);
      }
      return hit;
    }
    set(key, value) {
      this.map.delete(key);
      this.map.set(key, value);
      if (this.map.size > CACHE_MAX_ENTRIES) {
        const oldest = this.map.keys().next().value;
        if (oldest !== void 0) this.map.delete(oldest);
      }
    }
    clear() {
      this.map.clear();
    }
    get size() {
      return this.map.size;
    }
  };
  var llmCache = new LruCache();
  var configWatcherInstalled = false;
  function ensureLlmCacheInvalidationHook() {
    if (configWatcherInstalled) return;
    configWatcherInstalled = true;
    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && "engineConfig" in changes) {
          invalidateLlmCache();
        }
      });
    } catch {
    }
  }
  function invalidateLlmCache() {
    llmCache.clear();
  }
  var LLMTranslationProvider = class {
    constructor(opts) {
      this.opts = opts;
      this.timeoutMs = opts.bodyTimeoutMs ?? opts.timeoutMs ?? 3e4;
      this.fetchFn = opts.fetchFn;
    }
    opts;
    location = "cloud";
    /** 整體請求超時（SW 代理模式：等待完整響應）。 */
    timeoutMs;
    /** 可注入的 fetch 函數（測試用）。默認使用 SW 代理。 */
    fetchFn;
    get engineId() {
      return this.opts.engineId;
    }
    /**
     * 非流式翻譯：分塊 → 逐塊（快取命中直取 / miss 走重試 fetch）→ 合併結果。
     * 塊級瞬態重試耗盡 → 該塊原文兜底並記 diagLog（不阻塞其餘塊）。
     */
    async translate(req) {
      const merged = [];
      for (const chunk of chunkSegments(req.segments)) {
        const chunkResult = await this.translateChunkWithRetry(chunk, req);
        merged.push(...chunkResult);
      }
      return { segments: merged, engineId: this.opts.engineId, degraded: false };
    }
    /**
     * 流式（漸進）翻譯（M1-52）：分塊逐塊翻譯，每塊完成即 emit **累計全量**譯文——
     * pipeline/管線把 emit 依次作為 segments-ready → segments-updated，
     * 渲染層 5-10s 內先見首塊，後續塊增量替換（content-script onEvent 已支持兩者）。
     * 塊失敗（重試耗盡/永久失敗）→ 該塊原文兜底繼續，不中斷後續塊與 emit。
     */
    async translateStream(req, emit) {
      const accumulated = [];
      for (const chunk of chunkSegments(req.segments)) {
        if (req.signal?.aborted) {
          throw new DOMException("Translation aborted", "AbortError");
        }
        const chunkResult = await this.translateChunkWithRetry(chunk, req);
        accumulated.push(...chunkResult);
        emit({
          segments: [...accumulated],
          engineId: this.opts.engineId,
          degraded: false
        });
      }
    }
    /** 塊翻譯 + 快取 + 重試。瞬態失敗（transient）重試，永久失敗直接拋。不完整翻譯額外重試。 */
    async translateChunkWithRetry(chunk, req) {
      const cacheKey = this.cacheKey(chunk, req.targetLang);
      const cached = llmCache.get(cacheKey);
      if (cached) {
        diagLog("llm", "cache hit, chunk size:", chunk.length, "key:", cacheKey);
        return chunk.map((s, i) => ({
          ...s,
          translatedText: cached.get(String(i)) ?? s.sourceText,
          targetLang: req.targetLang
        }));
      }
      let lastErr = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          let map = await this.translateChunkOnce(chunk, req);
          if (map.size < chunk.length) {
            let missing = this.getMissingIndices(chunk, map);
            diagLog("llm", `incomplete translation (${map.size}/${chunk.length}), retrying with missing indices: ${missing.join(",")}`);
            for (let incAttempt = 0; incAttempt < INCOMPLETE_MAX_RETRIES; incAttempt++) {
              await sleep(INCOMPLETE_RETRY_DELAY_MS);
              const retryMap = await this.translateChunkOnce(chunk, req, missing);
              if (retryMap.size >= chunk.length) {
                map = retryMap;
                break;
              }
              missing = this.getMissingIndices(chunk, retryMap);
              diagLog("llm", `incomplete retry ${incAttempt + 1} still missing ${missing.length} lines`);
            }
            if (map.size < chunk.length) {
              console.warn(
                `[AI_Trans:diag] LLM: incomplete translation after ${INCOMPLETE_MAX_RETRIES} retries \u2014 expected ${chunk.length} lines, got ${map.size}. Some segments will show original text as translation.`
              );
            }
          }
          const duplicateInfo = this.detectDuplicates(map);
          if (duplicateInfo.hasExcessiveDuplicates) {
            diagLog("llm", `excessive duplicates detected (${duplicateInfo.duplicateCount} values repeated), retrying with duplicate warning`);
            for (let dupAttempt = 0; dupAttempt < DUPLICATE_MAX_RETRIES; dupAttempt++) {
              await sleep(INCOMPLETE_RETRY_DELAY_MS);
              const retryMap = await this.translateChunkOnce(chunk, req, void 0, true);
              const retryDupInfo = this.detectDuplicates(retryMap);
              if (!retryDupInfo.hasExcessiveDuplicates) {
                map = retryMap;
                break;
              }
              diagLog("llm", `duplicate retry ${dupAttempt + 1} still has ${retryDupInfo.duplicateCount} duplicates`);
            }
          }
          const langErrorInfo = this.detectLanguageError(map, req.targetLang);
          if (langErrorInfo.hasLanguageError) {
            diagLog("llm", `language error detected (${langErrorInfo.wrongLangCount}/${map.size} values in wrong language), retrying with language warning`);
            await sleep(INCOMPLETE_RETRY_DELAY_MS);
            const retryMap = await this.translateChunkOnce(chunk, req, void 0, false, true);
            const retryLangInfo = this.detectLanguageError(retryMap, req.targetLang);
            if (!retryLangInfo.hasLanguageError) {
              map = retryMap;
            } else {
              diagLog("llm", `language retry still has ${retryLangInfo.wrongLangCount} wrong-language values, using original result`);
            }
          }
          llmCache.set(cacheKey, map);
          return chunk.map((s, i) => ({
            ...s,
            translatedText: map.get(String(i)) ?? s.sourceText,
            targetLang: req.targetLang
          }));
        } catch (err) {
          if (err instanceof LLMRequestError && !err.transient) throw err;
          lastErr = err instanceof LLMRequestError ? err : new LLMRequestError(String(err), null, true);
        }
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS_MS[attempt] ?? 1500;
          diagLog("llm", `transient failure, retrying attempt ${attempt + 2}/${MAX_RETRIES + 1} after ${delay}ms`, String(lastErr));
          await sleep(delay);
        }
      }
      diagLog("llm", "all retries exhausted, fallback to original text for chunk", String(lastErr));
      return chunk.map((s) => ({
        ...s,
        translatedText: s.sourceText,
        targetLang: req.targetLang
      }));
    }
    /** 計算 chunk 中缺失的索引列表。 */
    getMissingIndices(chunk, map) {
      const missing = [];
      for (let i = 0; i < chunk.length; i++) {
        if (!map.has(String(i))) missing.push(i);
      }
      return missing;
    }
    /**
     * M2-31：偵測翻譯結果中的重複值。
     * 返回重複值數量及是否超過閾值（>30% 的值重複視為過度重複）。
     */
    detectDuplicates(map) {
      const valueCounts = /* @__PURE__ */ new Map();
      for (const v of map.values()) {
        valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
      }
      const duplicates = [...valueCounts.entries()].filter(([, c]) => c > 1);
      const duplicateCount = duplicates.length;
      const hasExcessiveDuplicates = duplicateCount > 0 && duplicateCount / map.size > 0.3;
      return { duplicateCount, hasExcessiveDuplicates };
    }
    /**
     * M2-32：偵測翻譯結果中的語言錯誤。
     * 小模型可能輸出非目標語言（如目標 zh-Hant 卻輸出西班牙語/韓語/日語/SVG 亂碼）。
     * 檢測邏輯：統計非目標語言字符比例，超過 50% 視為語言錯誤。
     */
    detectLanguageError(map, targetLang) {
      if (map.size === 0) return { hasLanguageError: false, wrongLangCount: 0 };
      let wrongLangCount = 0;
      const totalChars = { count: 0 };
      for (const value of map.values()) {
        const chars = [...value];
        totalChars.count += chars.length;
        let targetChars = 0;
        let otherChars = 0;
        for (const char of chars) {
          const code = char.charCodeAt(0);
          if (code < 48 || code >= 48 && code <= 63 || code === 32 || code === 160) continue;
          if (targetLang.startsWith("zh")) {
            if (code >= 19968 && code <= 40959 || code >= 13312 && code <= 19903 || code >= 12288 && code <= 12351 || code >= 65280 && code <= 65519) {
              targetChars++;
            } else if (code >= 65 && code <= 591 || // 拉丁字母
            code >= 1024 && code <= 1279 || // 西里爾字母
            code >= 12352 && code <= 12543 || // 日文假名
            code >= 44032 && code <= 55215) {
              otherChars++;
            }
          } else if (targetLang.startsWith("en")) {
            if (code >= 65 && code <= 591 || code >= 32 && code <= 127) {
              targetChars++;
            } else if (code >= 19968 && code <= 40959 || // CJK
            code >= 1024 && code <= 1279 || // 西里爾
            code >= 12352 && code <= 12543 || // 日文
            code >= 44032 && code <= 55215) {
              otherChars++;
            }
          } else if (targetLang.startsWith("ja")) {
            if (code >= 12352 && code <= 12543 || code >= 19968 && code <= 40959) {
              targetChars++;
            } else if (code >= 65 && code <= 591 || // 拉丁
            code >= 1024 && code <= 1279 || // 西里爾
            code >= 44032 && code <= 55215) {
              otherChars++;
            }
          } else if (targetLang.startsWith("ko")) {
            if (code >= 44032 && code <= 55215) {
              targetChars++;
            } else if (code >= 65 && code <= 591 || // 拉丁
            code >= 1024 && code <= 1279 || // 西里爾
            code >= 19968 && code <= 40959 || // CJK
            code >= 12352 && code <= 12543) {
              otherChars++;
            }
          } else {
            targetChars++;
          }
        }
        const totalMeaningful = targetChars + otherChars;
        if (totalMeaningful > 0 && otherChars / totalMeaningful > 0.5) {
          wrongLangCount++;
        }
      }
      const hasLanguageError = wrongLangCount > 0 && wrongLangCount / map.size > 0.3;
      return { hasLanguageError, wrongLangCount };
    }
    /** 塊翻譯一輪：fetch + parse；失敗拋 LLMRequestError（瞬態/永久按語義標記）。 */
    async translateChunkOnce(chunk, req, missingIndices, duplicateRetry = false, languageRetry = false) {
      const lines = chunk.map((s, i) => `${i}	${s.sourceText}`);
      let userContent = lines.join("\n");
      if (missingIndices?.length) {
        userContent += `

CRITICAL: Previous attempt only output ${missingIndices.length}/${chunk.length} lines. You MUST output ALL ${chunk.length} lines with their indices.`;
      }
      if (duplicateRetry) {
        userContent += `

IMPORTANT: Your previous output had duplicate translations for different indices. Each line MUST have a unique translation matching its source text.`;
      }
      if (languageRetry) {
        userContent += `

CRITICAL: Your previous output contained translations in the WRONG LANGUAGE. You MUST output ALL translations in ${req.targetLang} ONLY. Do NOT use any other language (no Spanish, no Korean, no Japanese, no English unless targetLang is English).`;
      }
      const body = {
        model: this.opts.model,
        temperature: 0.2,
        max_tokens: 4096,
        messages: [
          {
            role: "system",
            content: `You are a subtitle translator. Translate each numbered line to ${req.targetLang}.

CRITICAL RULES:
1. Output EXACTLY ${chunk.length} lines (one per input line, no more, no less)
2. Format: "index\\ttranslation" for each line (e.g., "0\\t\u4F60\u597D")
3. ALL translations MUST be in ${req.targetLang} only \u2014 do NOT output in any other language
4. Do NOT copy the same translation for different indices unless the source text is identical
5. Do NOT skip any line \u2014 every index from 0 to ${chunk.length - 1} must appear

Input example:
0	Hello world
1	Good morning

Output example:
0	\u4F60\u597D\u4E16\u754C
1	\u65E9\u4E0A\u597D`
          },
          ...req.context?.length ? [{ role: "user", content: `Context: ${req.context.join("\n")}` }] : [],
          { role: "user", content: userContent }
        ]
      };
      const response = await this.fetchDirectly({
        endpoint: this.opts.endpoint,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`
        },
        body: JSON.stringify(body)
      });
      diagLog("llm", "response status =", response.status, ", ok =", response.ok);
      if (!response.ok) {
        const transient = response.status === 429 || response.status >= 500;
        throw new LLMRequestError(`LLM translation failed: HTTP ${response.status}`, response.status, transient);
      }
      let data;
      try {
        data = JSON.parse(response.body);
        diagLog("llm", "JSON parsed, choices count =", data.choices?.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[AI_Trans:diag] LLM: JSON parse failed, body snippet =", response.body.substring(0, 200));
        throw new LLMRequestError(
          `LLM translation response is not valid JSON: ${msg}. Body snippet: ${response.body.substring(0, 200)}`,
          response.status,
          true
        );
      }
      const choice = data.choices?.[0];
      if (!choice || typeof choice.message?.content !== "string") {
        console.error("[AI_Trans:diag] LLM: no valid choices[0].message.content, choice =", choice);
        throw new LLMRequestError(
          "LLM translation response has no valid choices[0].message.content (possibly rate-limited or schema changed)",
          response.status,
          false
        );
      }
      const content = stripReasoning(choice.message.content);
      diagLog("llm", "content after stripReasoning =", content);
      const map = /* @__PURE__ */ new Map();
      for (const line of content.split("\n")) {
        const m = /^(\d+)\t(.+)$/.exec(line.trim());
        if (m) map.set(m[1], m[2]);
      }
      diagLog("llm", "parsed map size =", map.size, ", map =", Object.fromEntries(map));
      const valueCounts = /* @__PURE__ */ new Map();
      for (const v of map.values()) {
        valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
      }
      const duplicates = [...valueCounts.entries()].filter(([, c]) => c > 1);
      if (duplicates.length > 0) {
        console.warn(
          `[AI_Trans:diag] LLM: duplicate translations detected \u2014 ${duplicates.length} values appear multiple times. This may cause English-Chinese mismatch. Duplicates: ${duplicates.map(([v, c]) => `"${v.substring(0, 30)}..."\xD7${c}`).join(", ")}`
        );
      }
      return map;
    }
    /** 生成快取 key：model|targetLang|hash(塊源文)。 */
    cacheKey(chunk, targetLang) {
      return `${this.opts.model}|${targetLang}|${djb2Hash(chunk.map((s) => s.sourceText).join("\n"))}`;
    }
    /**
     * Fetch 翻譯端點。
     * - 測試模式（提供 fetchFn）：直接調用注入的 fetch 函數。
     * - 生產模式：通過 Service Worker 代理（繞過 CORS 限制）。
     *   Content-script 受 CORS 限制無法直接 fetch Ollama 等本地 LLM，
     *   由 SW 代理 POST 請求（SW 有 host_permissions 即可跨域 fetch）。
     */
    async fetchDirectly(request) {
      const startTime = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        if (this.fetchFn) {
          diagLog("llm", "fetching directly to", request.endpoint);
          const res = await this.fetchFn(request.endpoint, {
            method: "POST",
            headers: request.headers,
            body: request.body,
            signal: controller.signal
          });
          const elapsed2 = Date.now() - startTime;
          diagLog("llm", "fetch completed in", elapsed2, "ms, status =", res.status);
          const text = await res.text();
          return { ok: res.ok, status: res.status, body: text };
        }
        diagLog("llm", "fetching via SW proxy to", request.endpoint);
        const response = await Promise.race([
          chrome.runtime.sendMessage({
            topic: "sw:proxy-fetch-llm",
            payload: {
              url: request.endpoint,
              method: "POST",
              headers: request.headers,
              body: request.body
            }
          }),
          new Promise((_, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
        ]);
        const elapsed = Date.now() - startTime;
        if (response.error && !response.status) {
          diagLog("llm", "SW proxy fetch failed in", elapsed, "ms, error:", response.error);
          throw new LLMRequestError(
            `LLM network error: ${response.error}`,
            null,
            true
          );
        }
        diagLog("llm", "SW proxy fetch completed in", elapsed, "ms, status =", response.status);
        return {
          ok: response.ok,
          status: response.status ?? 200,
          body: response.body ?? ""
        };
      } catch (err) {
        if (err instanceof LLMRequestError) throw err;
        const isAbort = err instanceof DOMException ? err.name === "AbortError" : (err instanceof Error || typeof err === "object") && err?.name === "AbortError";
        if (isAbort) throw new LLMRequestError("LLM request timed out (aborted)", null, true);
        throw new LLMRequestError(
          `LLM network error: ${err instanceof Error ? err.message : String(err)}`,
          null,
          true
        );
      } finally {
        clearTimeout(timer);
      }
    }
  };
  function chunkSegments(segments) {
    const chunks = [];
    for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
      chunks.push(segments.slice(i, i + CHUNK_SIZE));
    }
    return chunks.length > 0 ? chunks : [[]];
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function stripReasoning(raw) {
    return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").replace(/^\s+/, "");
  }

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

  // src/adapters/translation/local-onnx-translation.ts
  var MAX_SESSION_DURATION_MS = 10 * 60 * 1e3;
  var modelStats = {
    totalChunks: 0,
    mergedChunks: 0,
    // 輸出行數 < 輸入行數的 chunks
    perfectChunks: 0,
    // 輸出行數 = 輸入行數的 chunks
    totalFallbacks: 0
    // 回退原文的行數
  };
  var LocalONNXTranslationProvider = class {
    engineId = "local-onnx";
    location = "local";
    defaultTargetLang;
    isPrimary;
    _chunkSize;
    /** Port 長連接——避免 sendMessage 短連接被 Service Worker 回收。 */
    port = null;
    messageIdCounter = 0;
    constructor(config) {
      void config.modelName;
      this.defaultTargetLang = config.targetLang ?? "zh-Hant";
      this.isPrimary = config.isPrimary ?? false;
      this._chunkSize = config.chunkSize ?? 5;
    }
    /** 返回配置的 chunk size。 */
    get chunkSize() {
      return this._chunkSize;
    }
    /**
     * 建立與 Service Worker 的 port 長連接。
     * 使用 port 而非 sendMessage，避免推理時間過長導致消息通道關閉。
     * 添加 port 有效性檢查：當 port 已斷開但 onDisconnect 回調尚未觸發時，
     * 主動清除並重建連接，避免 "Attempting to use a disconnected port object" 錯誤。
     */
    ensurePort() {
      if (this.port) {
        try {
          void this.port.name;
        } catch {
          diagLog("local-onnx", "port was disconnected, clearing reference");
          this.port = null;
        }
      }
      if (!this.port) {
        this.port = chrome.runtime.connect({ name: "content-onnx" });
        this.port.onDisconnect.addListener(() => {
          diagLog("local-onnx", "port disconnected, will reconnect on next request");
          this.port = null;
        });
      }
      return this.port;
    }
    /**
     * 預加載模型到記憶體——發送 `local-onnx:warmup` 給 Offscreen（經 SW 轉發）。
     * M2-24 補充修復十三：消除首次推理 30-60s 載入延遲（此前首塊 request 被 30s 超時誤殺）。
     * 模型未下載時拋錯（`local-onnx-warmup-failed` 診斷），調用方據此提示用戶先下載。
     * §5.6：warmup 失敗必須落診斷，禁止靜默吞掉。
     */
    async warmup() {
      try {
        const response = await chrome.runtime.sendMessage({ topic: "local-onnx:warmup" });
        const res = response;
        if (!res.ok) {
          throw new Error(res.error ?? "local-onnx warmup failed");
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "translation",
            code: "local-onnx-warmup-failed",
            recoverable: true,
            cause: error
          }
        });
        throw error;
      }
    }
    /**
     * 非流式翻譯——分塊發送給 Service Worker（轉發 Offscreen Document 執行 ONNX 推理）。
     * 分塊避免單次輸入過長壓垮小模型（回顯原文根因之一）。
     */
    async translate(req) {
      const targetLang = req.targetLang ?? this.defaultTargetLang;
      const translatedSegments = [];
      for (let i = 0; i < req.segments.length; i += this.chunkSize) {
        const chunk = req.segments.slice(i, i + this.chunkSize);
        const chunkResult = await this.translateChunk(chunk, targetLang);
        translatedSegments.push(...chunkResult.segments);
      }
      return {
        engineId: this.engineId,
        degraded: !this.isPrimary,
        // primary 成功不標降級；作 fallback 時仍標記。
        segments: translatedSegments
      };
    }
    /**
     * 翻譯單一 chunk——合併 sourceText 為單一請求（減少推理次數），
     * 將 Offscreen 返回的單一結果拆分回各 segment。
     * 模型依行號解析，少於輸入行數時缺行回退原文。
      */
    async translateChunk(chunk, targetLang) {
      const combinedText = chunk.map((s) => s.sourceText).join("\n");
      diagLog("local-onnx", `translateChunk: chunkSize=${chunk.length}, targetLang=${targetLang}`);
      const request = {
        topic: "local-onnx:translate",
        payload: {
          text: combinedText,
          targetLang
        }
      };
      diagLog("local-onnx", `requestTranslate: sending request`);
      const res = await this.requestTranslate(request);
      const rawOutput = res.translatedText ?? "";
      let translatedTexts;
      const outputLines = rawOutput.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      diagLog("local-onnx", `translateChunk: received response, rawOutput length=${rawOutput.length}, outputLines=${outputLines.length}`);
      if (outputLines.length === chunk.length) {
        translatedTexts = outputLines;
      } else if (outputLines.length < chunk.length) {
        diagLog(
          "local-onnx",
          `model-merge-detected: input=${chunk.length} lines, rawOutput=${outputLines.length} lines, inputText="${combinedText.slice(0, 100)}...", rawOutput="${rawOutput.slice(0, 200)}..."`
        );
        translatedTexts = this.splitBySentenceBoundary(rawOutput, chunk.length);
        if (translatedTexts.length < chunk.length) {
          diagLog(
            "local-onnx",
            `chunk output mismatch: input=${chunk.length} lines, output=${outputLines.length} lines, split=${translatedTexts.length} lines`
          );
        }
      } else {
        translatedTexts = outputLines;
      }
      const segments = chunk.map((seg, j) => ({
        ...seg,
        // 空譯文（''）亦視為無效，回退原文（避免渲染空行）。
        translatedText: translatedTexts[j]?.trim() || seg.sourceText
      }));
      modelStats.totalChunks++;
      if (outputLines.length < chunk.length) {
        modelStats.mergedChunks++;
        modelStats.totalFallbacks += chunk.length - translatedTexts.length;
      } else if (outputLines.length === chunk.length) {
        modelStats.perfectChunks++;
      }
      if (modelStats.totalChunks % 10 === 0) {
        diagLog("local-onnx", `model-stats: chunks=${modelStats.totalChunks}, merged=${modelStats.mergedChunks}, perfect=${modelStats.perfectChunks}, fallbacks=${modelStats.totalFallbacks}`);
      }
      return { segments, echoed: res.echoed === true };
    }
    /**
     * 按句子邊界分割文本——用於 Small model 輸出行數少於輸入行數的情況。
     * 嘗試按中文標點（。！？；）分割，如果分割後行數仍不足，則按逗號分割。
     * 如果仍不足，剩餘行回退到原文。
     */
    splitBySentenceBoundary(text, expectedLines) {
      const strongSplit = text.split(/[。！？；]/).filter((s) => s.trim().length > 0);
      if (strongSplit.length >= expectedLines) {
        return strongSplit.slice(0, expectedLines);
      }
      const weakSplit = text.split(/[，,、]/).filter((s) => s.trim().length > 0);
      if (weakSplit.length >= expectedLines) {
        return weakSplit.slice(0, expectedLines);
      }
      return weakSplit.length > 0 ? weakSplit : [text];
    }
    /**
     * 發送單次翻譯請求並校驗結果——使用 port 長連接。
     * §5.6：模型未下載/推理失敗/通信失敗都必須落診斷。
     */
    async requestTranslate(request) {
      try {
        const port = this.ensurePort();
        const messageId = `msg-${++this.messageIdCounter}-${Date.now()}`;
        const response = await new Promise((resolve, reject) => {
          const listener = (msg) => {
            const res = msg;
            if (res.messageId === messageId) {
              port.onMessage.removeListener(listener);
              if (res.error) {
                reject(new Error(res.error));
              } else if (res.result) {
                resolve(res.result);
              } else {
                reject(new Error("Empty response from offscreen"));
              }
            }
          };
          port.onMessage.addListener(listener);
          try {
            port.postMessage({ ...request, messageId });
          } catch (err) {
            port.onMessage.removeListener(listener);
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("disconnected port")) {
              this.port = null;
            }
            reject(err instanceof Error ? err : new Error(errMsg));
            return;
          }
          setTimeout(() => {
            port.onMessage.removeListener(listener);
            reject(new Error("Offscreen Document response timeout"));
          }, 12e4);
        });
        if (!response.ok) {
          const error = new Error(response.error ?? "local-onnx translation failed");
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "translation",
              code: response.notDownloaded ? "local-onnx-not-downloaded" : "local-onnx-inference-failed",
              recoverable: true,
              cause: error
            }
          });
          throw error;
        }
        return response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "translation",
            code: "local-onnx-communication-failed",
            recoverable: true,
            cause: error
          }
        });
        throw error;
      }
    }
    /**
     * 流式翻譯——逐 chunk 推理完成即 emit **累計全量**譯文（M2-24 補充修復十六）。
     * 修復：此前本地 ONNX 非真流式（`await this.translate(req)` 全量跑完才 emit 一次），
     * 431 段 = 87 次串行推理需數分鐘，NativeCaptionStrategy 首次 emit 才發 segments-ready，
     * 導致字幕長時間空白。現在首塊數秒內 emit，後續塊累計替換（與 LLM 流式同語義）。
     * 
     * 支持 AbortSignal：seek 時策略中斷翻譯，每個 chunk 前檢查 signal.aborted，
     * 已中止則拋 AbortError（不觸發 fallback，由策略層靜默處理）。
     * 
     * Fix D: 最大翻譯時限保護——連續翻譯超過 10 分鐘主動中斷，避免 Offscreen 長時間運行不穩定。
     */
    async translateStream(req, emit) {
      const targetLang = req.targetLang ?? this.defaultTargetLang;
      const accumulated = [];
      let echoedChunks = 0;
      const totalChunks = Math.ceil(req.segments.length / this.chunkSize);
      const streamStartedAt = performance.now();
      for (let i = 0; i < req.segments.length; i += this.chunkSize) {
        if (req.signal?.aborted) {
          diagLog("local-onnx", "translation aborted by signal after", accumulated.length, "segments");
          throw new DOMException("Translation aborted", "AbortError");
        }
        const elapsedMs = performance.now() - streamStartedAt;
        if (elapsedMs > MAX_SESSION_DURATION_MS) {
          diagLog("local-onnx", "translation session exceeded max duration", MAX_SESSION_DURATION_MS, "ms after", accumulated.length, "segments, aborting to prevent Offscreen instability");
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "translation",
              code: "local-onnx-session-timeout",
              recoverable: true,
              cause: new Error(
                `local-onnx translation session exceeded ${MAX_SESSION_DURATION_MS / 1e3}s (translated ${accumulated.length} segments), aborting to prevent Offscreen instability`
              )
            }
          });
          throw new Error("local-onnx session timeout (10min limit)");
        }
        const chunk = req.segments.slice(i, i + this.chunkSize);
        const chunkIndex = Math.floor(i / this.chunkSize) + 1;
        const chunkStartedAt = performance.now();
        const chunkResult = await this.translateChunk(chunk, targetLang);
        const chunkLatencyMs = Math.round(performance.now() - chunkStartedAt);
        accumulated.push(...chunkResult.segments);
        if (chunkResult.echoed) echoedChunks += 1;
        const totalElapsedMs = Math.round(performance.now() - streamStartedAt);
        const segmentsPerSec = (accumulated.length / (totalElapsedMs / 1e3)).toFixed(2);
        diagLog(
          "local-onnx",
          `chunk ${chunkIndex}/${totalChunks} done in ${chunkLatencyMs}ms, cumulative`,
          accumulated.length,
          "segments, echoed:",
          chunkResult.echoed,
          `| total: ${totalElapsedMs}ms, speed: ${segmentsPerSec} seg/s`
        );
        emit({
          engineId: this.engineId,
          degraded: !this.isPrimary,
          // primary 成功不標降級；作 fallback 時仍標記。
          segments: [...accumulated]
        });
      }
      this.recordEchoSummary(echoedChunks, totalChunks);
    }
    /**
     * 結束時若有 chunk 被判定為回顯原文 → 記聚合診斷（§5.6 留痕，popup「最近失敗」可見）。
     * 純診斷行為，不做任何降級/回退。
     */
    recordEchoSummary(echoedChunks, totalChunks) {
      if (echoedChunks === 0) return;
      recordDiagnostic({
        type: "pipeline-error",
        error: {
          port: "translation",
          code: "local-onnx-echo-chunks",
          recoverable: true,
          cause: new Error(
            `local ONNX model echoed input in ${echoedChunks}/${totalChunks} chunks (low quality output)`
          )
        }
      });
    }
  };

  // src/adapters/render/overlay-renderer.ts
  var NO_CUE_LOG_INTERVAL_MS = 5e3;
  var OverlayRenderer = class {
    root = null;
    styleEl = null;
    style = {};
    cues = [];
    currentId = null;
    // 日誌降壓欄位：避免每幀列印日誌造成控制台洪水洪災
    lastLoggedCueCount = -1;
    lastLoggedActiveId = null;
    lastNoCueLogTime = 0;
    mount(container, style = {}) {
      diagLog("overlay", "mount() called, container:", container.tagName, container.className);
      this.style = style;
      const styleEl = document.createElement("style");
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
      diagLog("overlay", "mount() completed, root appended to container");
    }
    render(cues, currentTime) {
      if (cues.length !== this.lastLoggedCueCount) {
        diagLog("overlay", "render() called, cues:", cues.length, "currentTime:", currentTime);
        this.lastLoggedCueCount = cues.length;
      }
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
      this.styleEl?.remove();
      this.styleEl = null;
      this.currentId = null;
    }
    draw(currentTime) {
      const active = this.cues.find(
        (c) => currentTime >= c.start && currentTime < c.end
      );
      if (active) {
        if (active.id !== this.lastLoggedActiveId) {
          diagLog("overlay", "draw() found active cue:", active.id, "start:", active.start, "end:", active.end);
          this.lastLoggedActiveId = active.id;
        }
        this.currentId = active.id;
        this.renderActive(active);
      } else {
        const now = Date.now();
        if (now - this.lastNoCueLogTime >= NO_CUE_LOG_INTERVAL_MS) {
          diagLog("overlay", "draw() no active cue for currentTime:", currentTime, "cues:", this.cues.length);
          if (this.cues.length > 0) {
            diagLog("overlay", "first cue range:", this.cues[0].start, "-", this.cues[0].end);
            const minStart = Math.min(...this.cues.map((c) => c.start));
            const maxEnd = Math.max(...this.cues.map((c) => c.end));
            const gap = currentTime - maxEnd;
            diagLog("overlay", "full coverage:", minStart, "-", maxEnd, "ms, gap vs currentTime:", gap, "ms", gap > 0 ? "(behind)" : "(ahead)");
          }
          this.lastNoCueLogTime = now;
        }
        this.clear();
      }
    }
    renderActive(cue) {
      if (!this.root) return;
      const bilingual = this.style["display-mode"] !== "mono";
      const parts = [];
      if (bilingual && cue.sourceText && cue.sourceText !== cue.translatedText) {
        parts.push(`<span class="ai-trans-src">${escapeHtml(cue.sourceText)}</span>`);
      }
      parts.push(`<span class="ai-trans-dst">${escapeHtml(cue.translatedText)}</span>`);
      this.root.innerHTML = parts.join("");
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

  // src/adapters/audio/tab-capture-source.ts
  var OFFSCREEN_URL = "src/runtime/offscreen.html";
  var seqCounter = 0;
  var TabCaptureAudioSource = class {
    kind = "tab-capture";
    port = null;
    chunkCallback = null;
    offscreenCreated = false;
    async open(_platform) {
      return {
        kind: "tab-capture",
        start: () => this.start(),
        stop: () => this.stop()
      };
    }
    onChunk(cb) {
      this.chunkCallback = cb;
    }
    /** 創建 Offscreen Document 並建立 port 連接。 */
    async start() {
      if (!this.offscreenCreated) {
        try {
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: [chrome.offscreen.Reason.USER_MEDIA],
            justification: "ASR audio processing: tabCapture + PCM extraction"
          });
          this.offscreenCreated = true;
        } catch (err) {
          if (!(err instanceof Error && err.message.includes("only one"))) {
            throw err;
          }
        }
      }
      this.port = chrome.runtime.connect({ name: "offscreen-asr" });
      this.port.onMessage.addListener((msg) => {
        this.handleMessage(msg);
      });
      this.port.onDisconnect.addListener(() => {
        if (this.port) {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            recordDiagnostic({
              type: "pipeline-error",
              error: {
                port: "audio",
                code: "offscreen-communication-failed",
                recoverable: true,
                cause: new Error(lastError.message)
              }
            });
          }
        }
        this.port = null;
      });
      const authState = await chrome.storage.local.get(["tabCaptureAuthorized", "tabCaptureStreamId"]);
      if (!authState.tabCaptureAuthorized || !authState.tabCaptureStreamId) {
        throw new Error("tabCapture not authorized or streamId missing");
      }
      this.port.postMessage({
        type: "startCapture",
        streamId: authState.tabCaptureStreamId
      });
    }
    /** 停止音頻捕獲並清理資源。 */
    async stop() {
      if (this.port) {
        this.port.postMessage({ type: "stopCapture" });
        this.port.disconnect();
        this.port = null;
      }
      if (this.offscreenCreated) {
        try {
          await chrome.offscreen.closeDocument();
        } catch {
        }
        this.offscreenCreated = false;
      }
      seqCounter = 0;
    }
    /** 處理來自 Offscreen Document 的消息。 */
    handleMessage(msg) {
      switch (msg.type) {
        case "audioChunk": {
          if (!this.chunkCallback) return;
          const chunk = {
            seq: seqCounter++,
            startTime: 0,
            // Offscreen 無法獲取視頻時間軸，由下游對齊。
            duration: msg.pcm.length / msg.sampleRate * 1e3,
            // ms
            sampleRate: msg.sampleRate,
            channels: 1,
            pcm: msg.pcm,
            isSpeech: true
            // 默認 true，VAD 會重新標記。
          };
          this.chunkCallback(chunk);
          break;
        }
        case "error": {
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "audio",
              code: "tab-capture-failed",
              recoverable: true,
              cause: new Error(msg.message)
            }
          });
          break;
        }
        case "captureStarted":
        case "captureStopped":
          break;
      }
    }
  };

  // src/adapters/asr/cloud-asr.ts
  function pcmToWav(pcm, sampleRate) {
    const numSamples = pcm.length;
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + numSamples * bytesPerSample);
    const view = new DataView(buffer);
    view.setUint32(0, 1380533830, false);
    view.setUint32(4, 36 + numSamples * bytesPerSample, true);
    view.setUint32(8, 1463899717, false);
    view.setUint32(12, 1718449184, false);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 1684108385, false);
    view.setUint32(40, numSamples * bytesPerSample, true);
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }
  var CloudASR = class {
    engineId;
    location = "cloud";
    endpoint;
    apiKey;
    model;
    constructor(config) {
      this.endpoint = config.endpoint;
      this.apiKey = config.apiKey;
      this.model = config.model ?? "whisper-1";
      this.engineId = config.endpoint.toLowerCase().includes("deepgram") ? "cloud-asr-deepgram" : "cloud-asr-openai";
    }
    async warmup(_config) {
    }
    async transcribe(req) {
      const startTime = performance.now();
      if (this.engineId === "cloud-asr-deepgram") {
        return this.transcribeDeepgram(req, startTime);
      }
      return this.transcribeOpenAI(req, startTime);
    }
    async transcribeStream(req, emit) {
      if (this.engineId === "cloud-asr-deepgram") {
        await this.transcribeDeepgramStream(req, emit);
        return;
      }
      const result = await this.transcribe(req);
      emit(result);
    }
    /** OpenAI Whisper API（multipart/form-data）。 */
    async transcribeOpenAI(req, startTime) {
      const { chunk, hintLang } = req;
      const wavBlob = pcmToWav(chunk.pcm, chunk.sampleRate);
      const formData = new FormData();
      formData.append("file", wavBlob, "audio.wav");
      formData.append("model", this.model);
      formData.append("response_format", "verbose_json");
      if (hintLang) formData.append("language", hintLang);
      const url = `${this.endpoint}/v1/audio/transcriptions`;
      const response = await globalThis.fetch.bind(globalThis)(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        },
        body: formData
      });
      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`OpenAI Whisper API failed: HTTP ${response.status}: ${errorText}`);
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "asr",
            code: "asr-engine-failed",
            recoverable: true,
            cause: error
          }
        });
        throw error;
      }
      const data = await response.json();
      const durationMs = performance.now() - startTime;
      const audioDurationMs = chunk.duration;
      const rtf = durationMs / audioDurationMs;
      const segments = data.segments?.map((seg, i) => ({
        id: `${chunk.seq}-${i}`,
        sourceText: seg.text.trim(),
        translatedText: void 0,
        // 由翻譯管線處理
        provisional: false,
        start: seg.start * 1e3,
        // 秒 → 毫秒
        end: seg.end * 1e3,
        origin: "realtime-asr",
        revision: 0
      })) ?? [
        {
          id: `${chunk.seq}-0`,
          sourceText: data.text.trim(),
          translatedText: void 0,
          provisional: false,
          start: 0,
          end: chunk.duration,
          origin: "realtime-asr",
          revision: 0
        }
      ];
      return {
        seq: chunk.seq,
        segments,
        isPartial: false,
        rtf
      };
    }
    /** Deepgram WebSocket 流式（非流式回退）。 */
    async transcribeDeepgram(req, startTime) {
      const { chunk, hintLang } = req;
      const wavBlob = pcmToWav(chunk.pcm, chunk.sampleRate);
      const url = `${this.endpoint}/v1/listen?model=nova-2${hintLang ? `&language=${hintLang}` : ""}`;
      const response = await globalThis.fetch.bind(globalThis)(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "audio/wav"
        },
        body: wavBlob
      });
      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Deepgram API failed: HTTP ${response.status}: ${errorText}`);
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "asr",
            code: "asr-engine-failed",
            recoverable: true,
            cause: error
          }
        });
        throw error;
      }
      const data = await response.json();
      const durationMs = performance.now() - startTime;
      const audioDurationMs = chunk.duration;
      const rtf = durationMs / audioDurationMs;
      const alternative = data.results.channels[0]?.alternatives[0];
      const segments = alternative ? [
        {
          id: `${chunk.seq}-0`,
          sourceText: alternative.transcript.trim(),
          translatedText: void 0,
          provisional: false,
          start: 0,
          end: chunk.duration,
          origin: "realtime-asr",
          revision: 0
        }
      ] : [];
      return {
        seq: chunk.seq,
        segments,
        isPartial: false,
        rtf
      };
    }
    /** Deepgram WebSocket 流式（provisional → final）。 */
    async transcribeDeepgramStream(req, emit) {
      const { chunk, hintLang } = req;
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true${hintLang ? `&language=${hintLang}` : ""}`;
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, ["token", this.apiKey]);
        let finalEmitted = false;
        ws.onopen = () => {
          const wavBlob = pcmToWav(chunk.pcm, chunk.sampleRate);
          wavBlob.arrayBuffer().then((buffer) => {
            ws.send(buffer);
            ws.send(JSON.stringify({ type: "CloseStream" }));
          });
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "Results" && data.channel?.alternatives?.[0]) {
              const alt = data.channel.alternatives[0];
              const isFinal = data.is_final === true;
              const segment = {
                id: `${chunk.seq}-0`,
                sourceText: alt.transcript.trim(),
                translatedText: void 0,
                provisional: !isFinal,
                start: 0,
                end: chunk.duration,
                origin: "realtime-asr",
                revision: 0
              };
              emit({
                seq: chunk.seq,
                segments: [segment],
                isPartial: !isFinal,
                rtf: void 0
                // 流式不計算 RTF。
              });
              if (isFinal) finalEmitted = true;
            }
          } catch {
          }
        };
        ws.onclose = () => {
          if (!finalEmitted) {
            emit({
              seq: chunk.seq,
              segments: [],
              isPartial: false,
              rtf: void 0
            });
          }
          resolve();
        };
        ws.onerror = (err) => {
          const error = new Error(`Deepgram WebSocket error: ${err}`);
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "asr",
              code: "asr-engine-failed",
              recoverable: true,
              cause: error
            }
          });
          reject(error);
        };
      });
    }
  };

  // src/adapters/asr/local-whisper.ts
  var WHISPER_MODELS = {
    tiny: "Xenova/whisper-tiny.en",
    base: "Xenova/whisper-base.en",
    small: "Xenova/whisper-small.en"
  };
  var LocalWhisperASR = class {
    engineId = "local-whisper";
    location = "local";
    modelId;
    warmedUp = false;
    constructor(config) {
      this.modelId = config.modelPath ?? WHISPER_MODELS[config.modelTier] ?? WHISPER_MODELS.base;
    }
    /**
     * 預熱模型——M2-37：轉發 warmup 請求給 Offscreen Document。
     * Offscreen Document 載入 Whisper pipeline 到記憶體，供後續推理使用。
     */
    async warmup(_config) {
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "asr-whisper:warmup",
          payload: { modelId: this.modelId }
        });
        const raw = response;
        const warmupResult = "result" in raw && raw.result ? raw.result : raw;
        if (!warmupResult?.ok) {
          throw new Error(warmupResult?.error ?? "warmup failed");
        }
        this.warmedUp = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isNetwork = /Failed to fetch|NetworkError|network/i.test(msg);
        const error = new Error(
          isNetwork ? `ASR warmup failed (network error). Check your connection and download the ASR model from Options. / ASR \u9810\u71B1\u5931\u6557\uFF08\u7DB2\u7D61\u932F\u8AA4\uFF09\uFF0C\u8ACB\u6AA2\u67E5\u7DB2\u7D61\u4E26\u5F9E\u9078\u9805\u9801\u9762\u4E0B\u8F09\u6A21\u578B: ${msg}` : `ASR warmup failed: ${msg}. Download the ASR model from Options. / \u8ACB\u5F9E\u9078\u9805\u9801\u9762\u4E0B\u8F09 ASR \u6A21\u578B`
        );
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "asr",
            code: "asr-engine-failed",
            recoverable: true,
            cause: error
          }
        });
        throw error;
      }
    }
    /** 非流式推理——M2-37：轉發推理請求給 Offscreen Document。 */
    async transcribe(req) {
      if (!this.warmedUp) {
        throw new Error("LocalWhisperASR not warmed up. Call warmup() first.");
      }
      const { chunk, hintLang } = req;
      const startTime = performance.now();
      try {
        const response = await chrome.runtime.sendMessage({
          topic: "asr-whisper:transcribe",
          payload: {
            pcm: chunk.pcm,
            sampleRate: chunk.duration > 0 ? Math.round(chunk.pcm.length / (chunk.duration / 1e3)) : 16e3,
            hintLang
          }
        });
        const raw = response;
        const transcribeResult = "result" in raw && raw.result ? raw.result : raw;
        if (!transcribeResult?.ok) {
          throw new Error(transcribeResult?.error ?? "transcribe failed");
        }
        const durationMs = performance.now() - startTime;
        const audioDurationMs = chunk.duration;
        const rtf = transcribeResult.rtf ?? durationMs / audioDurationMs;
        const segments = transcribeResult.chunks?.map((c, i) => ({
          id: `${chunk.seq}-${i}`,
          sourceText: c.text.trim(),
          translatedText: void 0,
          provisional: false,
          start: (c.timestamp?.[0] ?? 0) * 1e3,
          // 秒 → 毫秒
          end: (c.timestamp?.[1] ?? chunk.duration / 1e3) * 1e3,
          origin: "realtime-asr",
          revision: 0
        })) ?? [
          {
            id: `${chunk.seq}-0`,
            sourceText: transcribeResult.text?.trim() ?? "",
            translatedText: void 0,
            provisional: false,
            start: 0,
            end: chunk.duration,
            origin: "realtime-asr",
            revision: 0
          }
        ];
        return {
          seq: chunk.seq,
          segments,
          isPartial: false,
          rtf
        };
      } catch (err) {
        const error = new Error(
          `LocalWhisperASR transcribe failed: ${err instanceof Error ? err.message : String(err)}`
        );
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "asr",
            code: "asr-engine-failed",
            recoverable: true,
            cause: error
          }
        });
        throw error;
      }
    }
    /**
     * 流式推理——M2-37：轉發推理請求給 Offscreen Document。
     * 當前實現：將音頻塊分為 3 段，每段推理後 emit provisional，最後一段 emit final。
     */
    async transcribeStream(req, emit) {
      if (!this.warmedUp) {
        throw new Error("LocalWhisperASR not warmed up. Call warmup() first.");
      }
      const { chunk } = req;
      const segmentDuration = chunk.pcm.length / 3;
      const sampleRate = chunk.duration > 0 ? Math.round(chunk.pcm.length / (chunk.duration / 1e3)) : 16e3;
      for (let i = 0; i < 3; i++) {
        const start2 = Math.floor(i * segmentDuration);
        const end = Math.floor((i + 1) * segmentDuration);
        const segmentPcm = chunk.pcm.slice(start2, end);
        const isLast = i === 2;
        const startTime = performance.now();
        const response = await chrome.runtime.sendMessage({
          topic: "asr-whisper:transcribe",
          payload: {
            pcm: segmentPcm,
            sampleRate
          }
        });
        const raw = response;
        const transcribeResult = "result" in raw && raw.result ? raw.result : raw;
        if (!transcribeResult?.ok) {
          throw new Error(transcribeResult?.error ?? "transcribe failed");
        }
        const durationMs = performance.now() - startTime;
        const audioDurationMs = segmentPcm.length / sampleRate * 1e3;
        const rtf = transcribeResult.rtf ?? durationMs / audioDurationMs;
        const segment = {
          id: `${chunk.seq}-${i}`,
          sourceText: transcribeResult.text?.trim() ?? "",
          translatedText: void 0,
          provisional: !isLast,
          start: start2 / sampleRate * 1e3,
          end: end / sampleRate * 1e3,
          origin: "realtime-asr",
          revision: 0
        };
        emit({
          seq: chunk.seq,
          segments: [segment],
          isPartial: !isLast,
          rtf
        });
      }
    }
  };

  // src/runtime/composition.ts
  async function buildDefaultRegistry(config, opts) {
    const youtube = new YouTubePlatformAdapter({
      captionSource: new FetchCaptionSource(
        globalThis.document,
        globalThis.fetch,
        opts.captionCaptureProvider
      ),
      watchUrlRe: opts.platformWatchRe
    });
    const translation = await buildTranslationProviders(config, opts.apiKeyStore);
    ensureLlmCacheInvalidationHook();
    const audioSources = /* @__PURE__ */ new Map();
    audioSources.set("tab-capture", new TabCaptureAudioSource());
    const asr = await buildASRProviders(config, opts.apiKeyStore);
    return {
      platforms: [youtube],
      strategies: [
        new NativeCaptionStrategy(),
        new LookAheadASRStrategy(),
        new RealtimeASRStrategy()
      ],
      audioSources,
      asr,
      translation,
      renderer: new OverlayRenderer()
    };
  }
  async function buildASRProviders(config, apiKeyStore) {
    const providers = /* @__PURE__ */ new Map();
    if (config.asr.type === "local-whisper") {
      const whisper = new LocalWhisperASR({
        modelTier: config.asr.modelTier ?? "base",
        modelPath: config.asr.customModelPath
      });
      providers.set(whisper.engineId, whisper);
    } else if (config.asr.type === "cloud" && config.asr.endpoint) {
      const apiKey = await apiKeyStore.getApiKey("asr") ?? "";
      const cloud = new CloudASR({
        endpoint: config.asr.endpoint,
        apiKey,
        model: config.asr.modelTier
      });
      providers.set(cloud.engineId, cloud);
    }
    return providers;
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
    if (tc.type === "local-onnx" || tc.fallbackType === "local-onnx") {
      const localOnnx = new LocalONNXTranslationProvider({
        modelName: tc.localModelName ?? DEFAULT_LOCAL_TRANSLATION_MODEL,
        targetLang: config.targetLang,
        isPrimary: tc.type === "local-onnx",
        chunkSize: tc.localOnnxChunkSize ?? 5
      });
      providers.set(localOnnx.engineId, localOnnx);
    }
    return providers;
  }
  async function createLLM(tc, apiKeyStore) {
    if (tc.type !== "cloud-llm" && tc.type !== "local") return void 0;
    const endpoint = normalizeEndpoint(tc.endpoint);
    const model = tc.model ?? "gpt-4o-mini";
    const apiKey = await apiKeyStore.getApiKey("llm") ?? "";
    return new LLMTranslationProvider({
      engineId: tc.type === "local" ? "local-llm" : "llm",
      endpoint,
      model,
      apiKey
    });
  }

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
        asr: { ...base.asr, ...patch.asr ?? {} },
        // M2-34：debugLog 深合併——使用 base.debugLog 而非 DEFAULT_CONFIG.debugLog，
        // 避免部分 patch（如 Popup 切換 enabled）覆蓋已保存的調試設置。
        debugLog: { ...base.debugLog, ...patch.debugLog ?? {} }
      };
    }
  };

  // src/runtime/timedtext-bridge.ts
  var INTERCEPTOR_SCRIPT_URL = "src/runtime/yt-timedtext-interceptor.js";
  var CAPTURE_EVENT = "ai-trans:timedtext-capture";
  var TRACK_INFO_EVENT = "ai-trans:track-info";
  var POLL_INTERVAL_MS = 2e3;
  var VIDEO_SELECTOR = "video.html5-main-video, #mock-player video";
  var TimedTextBridge = class {
    latest = null;
    /** M2-22 第三層：MAIN world 發現的軌道信息（content script 無法訪問播放器 API 時的 fallback）。 */
    capturedTracks = null;
    /** M2-31：偵測到的音頻語言（從 timedtext URL 的 lang 參數提取，作為 audioLocale 的 fallback）。 */
    detectedAudioLang;
    onMessageBound;
    injected = false;
    pollTimer = null;
    /** 等待捕獲的 Promise 解析器隊列（waitForCapture 多路等待）。 */
    waiters = /* @__PURE__ */ new Set();
    /** M2-22 第四層：等待軌道信息的 Promise 解析器隊列。 */
    trackWaiters = /* @__PURE__ */ new Set();
    /** M2-24 補充修復十四：新捕獲訂閱者（晚捕獲重試等場景用）。 */
    captureSubscribers = /* @__PURE__ */ new Set();
    /** 已通知過訂閱者的捕獲時間戳：攔截器每 1.5s 重播同一捕獲，需過濾重複。 */
    lastNotifiedCapturedAt = null;
    constructor() {
      this.onMessageBound = this.onMessage.bind(this);
    }
    /** 注入 MAIN world 攔截腳本；重複調用安全（腳本內部有冪等標記）。 */
    inject() {
      if (this.injected) return;
      this.injected = true;
      const url = chrome.runtime.getURL(INTERCEPTOR_SCRIPT_URL);
      const script = document.createElement("script");
      script.src = url;
      script.dataset.aiTrans = "timedtext-interceptor";
      (document.head ?? document.documentElement).appendChild(script);
    }
    /** 啟動監聽 + 輪詢器；重複調用安全（先清理再重建）。 */
    start() {
      globalThis.removeEventListener("message", this.onMessageBound);
      globalThis.addEventListener("message", this.onMessageBound);
      this.ensurePolling();
    }
    /**
      * 等待最新捕獲值；超時返回 null（由調用方回退直接 fetch）。
      * 已在途的捕獲（latest 就緒且匹配）立即返回；否則掛起等待 message 事件或輪詢通知。
      * §5.4：所有 timer/listener 在 stop/dispose 時清理，不殘留。
      * expectedVideoId（M1-45）：僅接受屬於該視頻的捕獲——避免換視頻（SPA 導航）後
      * 複用上一個視頻的 stale 捕獲（不同視頻的 timedtext 響應不能互用）。
      */
    waitForCapture(timeoutMs, expectedVideoId) {
      diagLog("bridge", "waitForCapture called, timeoutMs:", timeoutMs, "expectedVideoId:", expectedVideoId, "hasLatest:", !!this.latest);
      const current = this.latest;
      if (current && this.matchesVideo(current, expectedVideoId)) {
        diagLog("bridge", "waitForCapture: latest available, returning immediately");
        return Promise.resolve(current);
      }
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.waiters.delete(onCapture);
          diagLog("bridge", "waitForCapture: timeout after", timeoutMs, "ms, returning null");
          resolve(null);
        }, timeoutMs);
        const onCapture = () => {
          if (settled) return;
          const latest = this.latest;
          if (!latest || !this.matchesVideo(latest, expectedVideoId)) return;
          settled = true;
          clearTimeout(timer);
          this.waiters.delete(onCapture);
          diagLog("bridge", "waitForCapture: capture received, videoId:", latest.videoId);
          resolve(latest);
        };
        this.waiters.add(onCapture);
        if (this.latest && this.matchesVideo(this.latest, expectedVideoId)) onCapture();
      });
    }
    /** 捕獲是否屬於指定視頻（無 expectedVideoId 或捕獲無 videoId 時視為可接受）。 */
    matchesVideo(capture, expectedVideoId) {
      if (!expectedVideoId) return true;
      if (!capture.videoId) return true;
      return capture.videoId === expectedVideoId;
    }
    /** 最新捕獲的 timedtext 響應；無則 null。 */
    getLatest() {
      return this.latest;
    }
    /**
     * M2-24 補充修復十四：訂閱「新捕獲」事件。
     * 僅在真正**新的**捕獲到達時觸發（攔截器 1.5s 重播同一捕獲不重複觸發），
     * 用於晚捕獲重試（管線已降級後捕獲才到的場景）。
     * 返回 unsubscribe；stop/dispose 後消息不再接收，訂閱自然失效（R4）。
     */
    onCapture(cb) {
      this.captureSubscribers.add(cb);
      return () => {
        this.captureSubscribers.delete(cb);
      };
    }
    /** 清空 latest 緩存（視頻切換時調用，避免複用舊視頻字幕）。 */
    clearLatest() {
      const previousVideoId = this.latest?.videoId ?? "(none)";
      diagLog("bridge", "clearLatest() called, previous videoId:", previousVideoId);
      this.latest = null;
      this.detectedAudioLang = void 0;
      this.lastNotifiedCapturedAt = null;
    }
    /**
     * M2-22 第三層：獲取 MAIN world 發現的軌道信息。
     * content script（isolated world）無法訪問 `movie_player.getOption()`，
     * 當 DOM stale 時使用這些信息作為 fallback。
     * 返回屬於指定視頻的軌道（無 expectedVideoId 時返回所有）。
     */
    getCapturedTracks(expectedVideoId) {
      if (!this.capturedTracks) return [];
      if (!expectedVideoId) return this.capturedTracks;
      return this.capturedTracks.filter((t) => t.videoId === expectedVideoId);
    }
    /**
     * M2-22 第四層：等待 MAIN world 發現的軌道信息。
     * 當 DOM stale 且播放器 API 不可用時，fetchTrackList 需要等待 bridge 收到軌道信息。
     * 類似 waitForCapture，但等待的是軌道信息而非完整捕獲。
     */
    waitForCapturedTracks(timeoutMs, expectedVideoId) {
      diagLog("bridge", "waitForCapturedTracks called, timeoutMs:", timeoutMs, "expectedVideoId:", expectedVideoId);
      const current = this.getCapturedTracks(expectedVideoId);
      if (current.length > 0) {
        diagLog("bridge", "waitForCapturedTracks: tracks available, returning immediately");
        return Promise.resolve(current);
      }
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.trackWaiters.delete(onTrack);
          diagLog("bridge", "waitForCapturedTracks: timeout after", timeoutMs, "ms, returning empty");
          resolve([]);
        }, timeoutMs);
        const onTrack = () => {
          if (settled) return;
          const tracks = this.getCapturedTracks(expectedVideoId);
          if (tracks.length === 0) return;
          settled = true;
          clearTimeout(timer);
          this.trackWaiters.delete(onTrack);
          diagLog("bridge", "waitForCapturedTracks: tracks received, count:", tracks.length);
          resolve(tracks);
        };
        this.trackWaiters.add(onTrack);
        if (this.getCapturedTracks(expectedVideoId).length > 0) onTrack();
      });
    }
    /** 停止監聽與輪詢，但保留 latest 緩存（restart 熱重載時不丟已捕獲響應）。 */
    stop() {
      globalThis.removeEventListener("message", this.onMessageBound);
      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }
    /** 徹底銷毀：移除監聽 + 停輪詢 + 清空 latest 與等待者。 */
    dispose() {
      this.stop();
      this.latest = null;
      this.lastNotifiedCapturedAt = null;
      this.captureSubscribers.clear();
      for (const w of this.waiters) w();
      this.waiters.clear();
      for (const w of this.trackWaiters) w();
      this.trackWaiters.clear();
    }
    /** 啟動 2s 輪詢（僅一份；探查播放狀態以維持捕獲通道活性）。 */
    ensurePolling() {
      if (this.pollTimer !== null) return;
      this.pollTimer = setInterval(() => {
        const video = document.querySelector(VIDEO_SELECTOR);
        const isPlaying = !!video && !video.paused && !video.ended && video.currentTime > 0;
        void isPlaying;
        this.notifyWaiters();
      }, POLL_INTERVAL_MS);
    }
    /** 通知所有 waitForCapture 等待者檢查最新值。 */
    notifyWaiters() {
      if (this.latest) {
        for (const w of Array.from(this.waiters)) w();
      }
    }
    /** M2-22 第四層：通知所有 waitForCapturedTracks 等待者檢查最新軌道信息。 */
    notifyTrackWaiters() {
      if (this.capturedTracks) {
        for (const w of Array.from(this.trackWaiters)) w();
      }
    }
    onMessage(event) {
      const data = event.data;
      if (!data || typeof data !== "object" || !data.__aiTrans) return;
      if (data.type === CAPTURE_EVENT) {
        const payload = data.payload;
        if (!payload || typeof payload.url !== "string" || typeof payload.responseText !== "string") return;
        this.latest = payload;
        if (payload.capturedAt !== this.lastNotifiedCapturedAt) {
          this.lastNotifiedCapturedAt = payload.capturedAt;
          const subscribers = Array.from(this.captureSubscribers);
          for (const cb of subscribers) {
            try {
              cb(payload);
            } catch {
            }
          }
        }
        this.notifyWaiters();
      } else if (data.type === TRACK_INFO_EVENT) {
        const payload = data.payload;
        if (!Array.isArray(payload)) return;
        diagLog("bridge", "received track info:", payload.length, "tracks");
        this.capturedTracks = payload;
        if (!this.detectedAudioLang && payload.length > 0 && payload[0].audioLang) {
          this.detectedAudioLang = payload[0].audioLang;
          diagLog("bridge", "detected audio language from interceptor:", this.detectedAudioLang);
        }
        this.notifyTrackWaiters();
      }
    }
    /** M2-31：獲取偵測到的音頻語言（從 timedtext URL 的 lang 參數提取）。 */
    getAudioLanguage() {
      return this.detectedAudioLang;
    }
  };

  // src/runtime/watch-url.ts
  var YT_HOST_RE = /^(www\.)?youtube\.com$/;
  function isWatchPage(url) {
    try {
      const u = new URL(url);
      if (YT_HOST_RE.test(u.hostname)) {
        return u.pathname === "/watch" && u.searchParams.has("v");
      }
      return u.hostname === "localhost";
    } catch {
      return false;
    }
  }

  // src/runtime/content-script.ts
  var PLAYER_SELECTOR = "div#movie_player, .html5-video-player, #mock-player";
  function extractVideoId(url) {
    try {
      return new URL(url).searchParams.get("v") ?? "";
    } catch {
      return "";
    }
  }
  var MOUNT_WAIT_TIMEOUT_MS = 15e3;
  var MAX_LATE_CAPTURE_RETRIES = 3;
  var LATE_CAPTURE_RETRY_COOLDOWN_MS = 5e3;
  var store = new ChromeStorageConfigStore();
  var SubtitleController = class _SubtitleController {
    constructor(config, url) {
      this.config = config;
      this.url = url;
      this.lastVideoId = extractVideoId(url);
      this.onUrlChangedBound = this.onUrlChanged.bind(this);
      globalThis.addEventListener("popstate", this.onUrlChangedBound);
      this.origPushState = history.pushState;
      this.origReplaceState = history.replaceState;
      this.patchedHistory = this.patchHistoryApi();
      this.urlChangeTimer = null;
      const onStorageChanged = (changes, areaName) => {
        if (areaName !== "local") return;
        if ("engineConfig" in changes || "engineConfigKeys" in changes) {
          void this.restart().catch((err) => {
            recordDiagnostic({
              type: "pipeline-error",
              error: {
                port: "platform",
                code: "config-hot-reload-failed",
                recoverable: true,
                cause: err instanceof Error ? err : new Error(String(err))
              }
            });
          });
        }
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
      this.unsubscribeConfig = () => chrome.storage.onChanged.removeListener(onStorageChanged);
      const onAsrAuthChanged = (changes, areaName) => {
        if (areaName !== "local" || !("tabCaptureAuthorized" in changes)) return;
        const newValue = changes.tabCaptureAuthorized.newValue;
        if (newValue === this.tabCaptureAuthorized) return;
        this.tabCaptureAuthorized = newValue;
        void this.restart().catch((err) => {
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "platform",
              code: "asr-auth-restart-failed",
              recoverable: true,
              cause: err instanceof Error ? err : new Error(String(err))
            }
          });
        });
      };
      chrome.storage.onChanged.addListener(onAsrAuthChanged);
      this.unsubscribeAsrAuth = () => chrome.storage.onChanged.removeListener(onAsrAuthChanged);
    }
    config;
    renderer = new OverlayRenderer();
    cues = [];
    currentTime = 0;
    mounted = false;
    orchestrator = null;
    rafId = 0;
    url;
    // MAIN world 播放器 timedtext 響應攔截橋：捕獲播放器真實請求（含 pot），供字幕管線複用。
    bridge = new TimedTextBridge();
    // R4：所有需解除的訂閱句柄，restart/stop 前必須全部清理，避免線性累積。
    unsubscribePlayback = null;
    unsubscribeConfig = null;
    unsubscribeAsrAuth = null;
    // M2-24 補充修復十四：bridge 新捕獲訂閱句柄（R4：stop/dispose 必須解除）。
    unsubscribeCapture = null;
    // M2-24 補充修復十四：晚捕獲重試狀態機（no-caption-strategy 降級後等待捕獲到達重試）。
    lateCaptureRetry = new LateCaptureRetry({
      maxRetries: MAX_LATE_CAPTURE_RETRIES,
      cooldownMs: LATE_CAPTURE_RETRY_COOLDOWN_MS
    });
    pendingMountObserver = null;
    mountWaitTimer = null;
    // M1-51：調試旗標中繼重播定時器（跨 world 監聽器晚就位場景），restart/stop 清理（R4）。
    debugFlagRelayTimer = null;
    // M2-14：tabCapture 授權狀態（content-script 啟動時讀取，授權變更時熱重啟）。
    tabCaptureAuthorized = false;
    // SPA 換視頻監聽（M1-45）：YouTube 換視頻走 pushState，content-script 不會重載；
    // 偵測 URL 的 v 參數變化後熱重啟字幕管線。dispose 時必須解除/恢復（R4）。
    onUrlChangedBound;
    origPushState;
    origReplaceState;
    patchedHistory;
    lastVideoId;
    urlChangeTimer = null;
    // M2-21：URL 輪詢偵測（兜底機制）：YouTube 可能覆蓋我們的 pushState patch，
    // 導致 onUrlChanged() 不被觸發。定期檢查 location.href 變化作為兜底。
    urlPollTimer = null;
    /** URL 輪詢間隔（毫秒）：1.5 秒檢查一次，平衡響應速度與性能。 */
    static URL_POLL_INTERVAL_MS = 1500;
    /** 加載配置 → 組裝 → 掛載 → 啟動 Orchestrator。 */
    async start() {
      if (!this.config.enabled) {
        diagLog("content", "start() skipped: extension disabled by user");
        document.dispatchEvent(new CustomEvent("ai-trans:disable"));
        return;
      }
      document.dispatchEvent(new CustomEvent("ai-trans:enable"));
      const authState = await chrome.storage.local.get("tabCaptureAuthorized");
      this.tabCaptureAuthorized = authState.tabCaptureAuthorized === true;
      this.applyDebugFlags();
      this.bridge.inject();
      this.bridge.start();
      this.unsubscribeCapture = this.bridge.onCapture((capture) => {
        this.onBridgeCapture(capture);
      });
      document.dispatchEvent(
        new CustomEvent("ai-trans:set-target-lang", {
          detail: { targetLang: this.config.targetLang }
        })
      );
      diagLog("content", "Sent set-target-lang message to MAIN world:", this.config.targetLang);
      const currentUrl = this.currentUrl();
      this.startUrlPolling();
      if (!isWatchPage(currentUrl)) {
        return;
      }
      await this.ensureMounted();
      const isMockHost = /^https?:\/\/localhost(:\d+)?\//.test(currentUrl);
      const platformWatchRe = isMockHost ? /^https?:\/\/localhost(:\d+)?\// : void 0;
      const registry = await buildDefaultRegistry(this.config, {
        apiKeyStore: store,
        platformWatchRe,
        captionCaptureProvider: this.bridge
      });
      this.orchestrator = new Orchestrator(
        { registry, getConfig: () => store.get(), enableAsr: this.tabCaptureAuthorized },
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
      await this.orchestrator.start(currentUrl);
    }
    /** 取得當前頁面 URL（M1-47：每次 start/restart 都讀最新 location）。 */
    currentUrl() {
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
    applyDebugFlags() {
      setDebugFlags(this.config.debugLog);
      const dispatch = () => document.dispatchEvent(
        new CustomEvent("ai-trans:set-debug-flags", {
          detail: { flags: this.config.debugLog }
        })
      );
      dispatch();
      if (this.debugFlagRelayTimer !== null) {
        clearInterval(this.debugFlagRelayTimer);
        this.debugFlagRelayTimer = null;
      }
      let relayed = 0;
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
    async restart() {
      diagLog("content", "restart() called");
      this.stop();
      diagLog("content", "restart() stop() completed");
      this.config = await store.get();
      if (!this.config.enabled) {
        diagLog("content", "restart() stopped: extension disabled");
        document.dispatchEvent(new CustomEvent("ai-trans:disable"));
        return;
      }
      await this.start();
      diagLog("content", "restart() start() completed");
    }
    stop() {
      cancelAnimationFrame(this.rafId);
      this.stopUrlPolling();
      this.pendingMountObserver?.disconnect();
      this.pendingMountObserver = null;
      if (this.mountWaitTimer !== null) {
        clearTimeout(this.mountWaitTimer);
        this.mountWaitTimer = null;
      }
      if (this.debugFlagRelayTimer !== null) {
        clearInterval(this.debugFlagRelayTimer);
        this.debugFlagRelayTimer = null;
      }
      this.unsubscribePlayback?.();
      this.unsubscribePlayback = null;
      this.unsubscribeCapture?.();
      this.unsubscribeCapture = null;
      this.lateCaptureRetry.disarm();
      this.bridge.stop();
      this.orchestrator?.stop();
      this.orchestrator = null;
      this.renderer.unmount();
      this.mounted = false;
      this.cues = [];
    }
    /** 徹底銷毀：解除配置訂閱（頁面卸載/SPA 導航離開時調用）。 */
    dispose() {
      this.stop();
      this.bridge.dispose();
      this.unsubscribeConfig?.();
      this.unsubscribeConfig = null;
      this.unsubscribeAsrAuth?.();
      this.unsubscribeAsrAuth = null;
      globalThis.removeEventListener("popstate", this.onUrlChangedBound);
      if (this.patchedHistory) {
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
    startUrlPolling() {
      if (this.urlPollTimer !== null) return;
      diagLog("content", "startUrlPolling: starting URL polling with interval", _SubtitleController.URL_POLL_INTERVAL_MS, "ms");
      this.urlPollTimer = setInterval(() => {
        const currentVideoId = extractVideoId(window.location.href);
        if (currentVideoId !== this.lastVideoId) {
          diagLog("content", "urlPollTimer: videoId changed from", this.lastVideoId, "to", currentVideoId);
          this.onUrlChanged();
        }
      }, _SubtitleController.URL_POLL_INTERVAL_MS);
    }
    /** M2-21：停止 URL 輪詢偵測（§5.4：註冊必配解除）。 */
    stopUrlPolling() {
      if (this.urlPollTimer !== null) {
        clearInterval(this.urlPollTimer);
        this.urlPollTimer = null;
        diagLog("content", "stopUrlPolling: URL polling stopped");
      }
    }
    /** 偵測 URL 的 v 參數變化（SPA 換視頻）→ 熱重啟字幕管線（M1-45）。 */
    onUrlChanged() {
      if (this.urlChangeTimer !== null) return;
      const videoId = extractVideoId(window.location.href);
      diagLog("content", "onUrlChanged triggered:", "oldVideoId:", this.lastVideoId, "newVideoId:", videoId, "url:", window.location.href);
      if (videoId === this.lastVideoId) return;
      this.lastVideoId = videoId;
      this.bridge.clearLatest();
      document.dispatchEvent(new CustomEvent("ai-trans:video-changed"));
      diagLog("content", "Dispatched ai-trans:video-changed event to MAIN world interceptor");
      this.urlChangeTimer = setTimeout(() => {
        this.urlChangeTimer = null;
        diagLog("content", "restart() starting after URL change");
        void this.restart().then(() => {
          diagLog("content", "restart() completed successfully");
        }).catch((err) => {
          diagLog("content", "restart() failed:", err instanceof Error ? err.message : String(err));
          recordDiagnostic({
            type: "pipeline-error",
            error: {
              port: "platform",
              code: "spa-navigation-restart-failed",
              recoverable: true,
              cause: err instanceof Error ? err : new Error(String(err))
            }
          });
        });
      }, 300);
    }
    /**
     * Patch history.pushState/replaceState，捕獲 SPA 換視頻導航（R4 需可解除）。
     * 返回是否成功 patch（patch 失敗時僅靠 popstate 兜底）。
     */
    patchHistoryApi() {
      try {
        history.pushState = ((data, unused, url) => {
          this.origPushState.call(history, data, unused, url);
          this.onUrlChanged();
        });
        history.replaceState = ((data, unused, url) => {
          this.origReplaceState.call(history, data, unused, url);
          this.onUrlChanged();
        });
        return true;
      } catch (err) {
        console.warn("[AI_Trans] SPA navigation patch failed, falling back to popstate only:", err);
        return false;
      }
    }
    onEvent(e) {
      if (e.type === "segments-ready" || e.type === "segments-updated") {
        diagLog("content", "onEvent received", e.type, "with", e.segments.length, "segments");
        this.cues = e.segments.map((s) => ({
          id: s.id,
          sourceText: s.sourceText,
          translatedText: s.translatedText ?? s.sourceText,
          provisional: s.provisional,
          start: s.start,
          end: s.end
        }));
        if (this.cues.length > 0) {
          const maxEnd = Math.max(...this.cues.map((c) => c.end));
          const gap = this.currentTime - maxEnd;
          diagLog("content", "playback-cue gap:", gap, "ms (currentTime:", this.currentTime, "maxEnd:", maxEnd, ")", gap > 0 ? "BEHIND" : "AHEAD");
        }
        this.lateCaptureRetry.disarm();
        diagLog("content", "cues updated, count:", this.cues.length, "calling scheduleDraw");
        this.scheduleDraw();
        return;
      }
      if (e.type === "pipeline-error" && e.error.code === "no-caption-strategy") {
        const videoId = extractVideoId(this.currentUrl());
        this.lateCaptureRetry.arm(videoId || null);
        diagLog("content", "no-caption-strategy: arming late-capture retry for videoId:", videoId);
      }
      diagLog("content", "onEvent received", e.type, e.type === "engine-degraded" ? e.reason : "");
      void recordDiagnostic(e);
    }
    /**
     * M2-24 補充修復十四：bridge 捕獲到**新** timedtext 響應。
     * 管線因 native 捕獲晚到而降級（no-caption-strategy）時，捕獲最終到達即為重試信號：
     * 同一視頻 + 未達上限 + 未在冷卻內 → 輕量重跑 Orchestrator（重新跑策略鏈），
     * native 的 fetchTracks→tryReuseCapture 會立刻命中該晚捕獲（bridge 保留 latest）。
     * 守衛：videoId 比對、重試上限、冷卻、segments-ready 解除（見 onEvent/stop）。
     */
    onBridgeCapture(capture) {
      const attempt = this.lateCaptureRetry.onCapture(capture);
      if (attempt === null) return;
      Reflect.set(globalThis, "__aiTransLateCaptureRetries", attempt);
      Reflect.set(globalThis, "__aiTransCaptureLatencyMs", this.lateCaptureRetry.latencyMs);
      diagLog("content", "onBridgeCapture: late capture arrived, retrying native strategy (attempt", attempt, "/", MAX_LATE_CAPTURE_RETRIES, ")");
      void this.retryAfterLateCapture().catch((err) => {
        diagLog("content", "retryAfterLateCapture failed:", err instanceof Error ? err.message : String(err));
        recordDiagnostic({
          type: "pipeline-error",
          error: {
            port: "platform",
            code: "native-capture-late-retry",
            recoverable: true,
            cause: err instanceof Error ? err : new Error(String(err))
          }
        });
      });
    }
    /** M2-24 補充修復十四：輕量重跑策略鏈（晚捕獲重試）。不重掛 overlay、不重讀配置。 */
    async retryAfterLateCapture() {
      if (!this.orchestrator) return;
      const url = this.currentUrl();
      diagLog("content", "retryAfterLateCapture: re-running strategy chain for", url);
      await this.orchestrator.start(url);
      diagLog("content", "retryAfterLateCapture: completed");
    }
    /** 播放器就緒後自動掛載覆蓋層；未就緒時等待 DOM 出現（YouTube 播放器異步加載）。 */
    async ensureMounted() {
      if (!document.querySelector(PLAYER_SELECTOR)) {
        let timedOut = false;
        await new Promise((resolve) => {
          let settled = false;
          const finish = (fromTimeout) => {
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
          this.mountWaitTimer = setTimeout(() => finish(true), MOUNT_WAIT_TIMEOUT_MS);
        });
        if (timedOut) {
          this.onEvent({
            type: "pipeline-error",
            error: {
              port: "platform",
              code: "player-not-found",
              recoverable: true,
              cause: new Error(
                `player not found within ${MOUNT_WAIT_TIMEOUT_MS}ms (selector: ${PLAYER_SELECTOR})`
              )
            }
          });
        }
      }
      this.mountOverlay();
    }
    mountOverlay() {
      const player = document.querySelector(PLAYER_SELECTOR);
      if (!player || this.mounted) return;
      this.renderer.mount(player, {
        "font-size": this.config.subtitleStyle?.["font-size"] ?? "24px",
        color: this.config.subtitleStyle?.color ?? "#fff",
        "text-shadow": "0 0 4px #000, 0 0 2px #000",
        "background-color": this.config.subtitleStyle?.["background-color"] ?? "rgba(32, 32, 32, 0.7)",
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
    let config;
    try {
      config = await store.get();
    } catch (err) {
      recordDiagnostic({
        type: "pipeline-error",
        error: {
          port: "platform",
          code: "config-load-failed",
          recoverable: false,
          cause: err instanceof Error ? err : new Error(String(err))
        }
      });
      return;
    }
    const controller = new SubtitleController(config, window.location.href);
    await controller.start();
  }
  void start().catch((err) => {
    recordDiagnostic({
      type: "pipeline-error",
      error: {
        port: "platform",
        code: "content-script-start-failed",
        recoverable: false,
        cause: err instanceof Error ? err : new Error(String(err))
      }
    });
  });
})();

