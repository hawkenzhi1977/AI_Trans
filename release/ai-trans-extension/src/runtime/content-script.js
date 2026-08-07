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
  };

  // src/domain/models/config.ts
  var DEBUG_LOG_OFF = {
    overlay: false,
    llm: false,
    capture: false,
    pipeline: false,
    strategy: false,
    content: false,
    bridge: false,
    interceptor: false
  };
  var DEFAULT_CONFIG = {
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
    debugLog: DEBUG_LOG_OFF
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
        if (this.opts.fallback) {
          diagLog("pipeline", "falling back to:", this.opts.fallback.engineId);
          this.emit({
            type: "engine-degraded",
            port: "translation",
            reason: `primary failed: ${String(primaryErr)}`
          });
          this.emitError(primaryErr);
          const result = await this.opts.fallback.translate(request);
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
      diagLog("strategy", "track.fetch() starting");
      const segments = await track.fetch();
      diagLog("strategy", "track.fetch() returned", segments.length, "segments");
      if (this.stopped) return;
      try {
        diagLog("strategy", "translation starting, targetLang:", ctx.config.targetLang);
        if (ctx.translation.translateStream) {
          let firstEmit = true;
          diagLog("strategy", "using translateStream (chunked progressive)");
          await ctx.translation.translateStream(
            { segments, targetLang: ctx.config.targetLang },
            (result2) => {
              if (this.stopped) return;
              if (firstEmit) {
                firstEmit = false;
                diagLog("strategy", "emit segments-ready,", result2.segments.length, "segments");
                emit({ type: "segments-ready", segments: result2.segments });
              } else {
                diagLog("strategy", "emit segments-updated,", result2.segments.length, "segments");
                emit({ type: "segments-updated", segments: result2.segments });
              }
            }
          );
          if (this.stopped) return;
          return;
        }
        const result = await ctx.translation.translate({
          segments,
          targetLang: ctx.config.targetLang
        });
        diagLog("strategy", "translation succeeded,", result.segments.length, "translated segments");
        if (this.stopped) return;
        diagLog("strategy", "emitting segments-ready");
        emit({ type: "segments-ready", segments: result.segments });
      } catch (err) {
        diagLog("strategy", "translation FAILED:", err instanceof Error ? err.message : String(err));
        if (this.stopped) return;
        emit({
          type: "engine-degraded",
          port: "translation",
          reason: `translation failed, falling back to original subtitles: ${err instanceof Error ? err.message : String(err)}`
        });
        const fallbackSegments = segments.map((s) => ({
          ...s,
          translatedText: s.sourceText,
          targetLang: s.sourceLang
        }));
        emit({ type: "segments-ready", segments: fallbackSegments });
      }
    }
    stop() {
      this.stopped = true;
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

  // src/application/strategies/realtime-asr-strategy.ts
  var RealtimeASRStrategy = class {
    origin = "realtime-asr";
    async isApplicable(ctx) {
      ctx.diagnostics?.push?.("realtime-asr: not implemented (M2)");
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
    if (trimmed.startsWith("{")) {
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
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new Error(
        `timedtext XML: parse error (not valid XML) \u2014 root <${doc.documentElement?.tagName ?? "unknown"}>, body snippet: ${snippet(raw, 120)}`
      );
    }
    const timedtextRoot = doc.getElementsByTagName("timedtext")[0];
    if (timedtextRoot && timedtextRoot.getElementsByTagName("p").length > 0) {
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
    constructor(doc = globalThis.document, fetchFn = globalThis.fetch, captureProvider, waitForCaptureTimeoutMs = 15e3) {
      this.doc = doc;
      this.fetchFn = fetchFn === globalThis.fetch ? fetchFn.bind(globalThis) : fetchFn;
      this.captureProvider = captureProvider;
      this.waitForCaptureTimeoutMs = waitForCaptureTimeoutMs;
    }
    /**
     * 當前頁面 URL 中的視頻 ID（從 `/watch?v=` 提取；SPA 換視頻後 location.href 會更新）。
     * 用於跨視頻捕獲失效校驗：capture.videoId 與之不一致即視為 stale。
     */
    currentVideoId() {
      try {
        const href = this.doc.location?.href;
        if (!href) return "";
        return new URL(href).searchParams.get("v") ?? "";
      } catch {
        return "";
      }
    }
    getLastTrackDiagnostic() {
      return this.lastTrackDiagnostic;
    }
    async fetchTrackList() {
      const json = this.findPlayerResponseJson();
      if (!json) {
        this.lastTrackDiagnostic = "player response JSON not found (ytInitialPlayerResponse missing/empty)";
        return [];
      }
      let data;
      try {
        data = JSON.parse(json);
      } catch (err) {
        this.lastTrackDiagnostic = `player response JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
        return [];
      }
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (tracks.length === 0) {
        this.lastTrackDiagnostic = "player response has no captionTracks (video may have no captions)";
      } else {
        this.lastTrackDiagnostic = void 0;
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
      diagLog("capture", "fetchTracks called, baseUrl:", baseUrl, "lang:", lang);
      let url;
      try {
        url = new URL(baseUrl, globalThis.location?.href ?? baseUrl).href;
      } catch (err) {
        throw new Error(
          `timedtext URL construct failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const finalUrl = this.withJson3Format(url);
      diagLog("capture", "fetchTracks: finalUrl after withJson3Format:", finalUrl);
      diagLog("capture", "fetchTracks: trying tryReuseCapture");
      const reused = this.tryReuseCapture(lang);
      if (reused) {
        diagLog("capture", "fetchTracks: reused capture success");
        return reused;
      }
      diagLog("capture", "fetchTracks: no capture to reuse, trying waitForCaptureReuse");
      const waited = await this.waitForCaptureReuse(lang);
      if (waited) {
        diagLog("capture", "fetchTracks: waitForCaptureReuse success");
        return waited;
      }
      diagLog("capture", "fetchTracks: waitForCaptureReuse timeout, falling back to direct fetch");
      let res;
      try {
        res = await this.fetchFn(finalUrl, { credentials: "include" });
      } catch (err) {
        const msg = `timedtext fetch failed: ${err instanceof Error ? err.message : String(err)} (url: ${finalUrl})`;
        this.lastTrackDiagnostic = msg;
        throw new Error(msg);
      }
      if (!res.ok) {
        const msg = `timedtext fetch HTTP ${res.status} (url: ${finalUrl})`;
        this.lastTrackDiagnostic = msg;
        throw new Error(msg);
      }
      let raw;
      try {
        raw = await res.text();
      } catch (err) {
        const msg = `timedtext body read failed: ${err instanceof Error ? err.message : String(err)}`;
        this.lastTrackDiagnostic = msg;
        throw new Error(msg);
      }
      try {
        return parseTimedText(raw, lang);
      } catch (err) {
        const msg = `${err instanceof Error ? err.message : String(err)} (content-type: ${res.headers.get("content-type") ?? "unknown"})`;
        this.lastTrackDiagnostic = msg;
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
     * - 有捕獲值、響應非空且屬於當前視頻 → 解析；解析失敗記診斷並回退（返回 undefined 讓 fetch 兜底）。
     * - 無捕獲值 / 捕獲屬於其他視頻（stale）→ 返回 undefined（走等待或直接 fetch）。
     */
    tryReuseCapture(lang) {
      if (!this.captureProvider) return void 0;
      const capture = this.captureProvider.getLatest();
      if (!capture || !capture.responseText) return void 0;
      if (!this.captureMatchesCurrentVideo(capture)) {
        this.lastTrackDiagnostic = `timedtext capture is for another video (capture videoId: ${capture.videoId ?? "(unknown)"}, current: ${this.currentVideoId()}) \u2014 skip reuse`;
        return void 0;
      }
      const { url, responseText, contentType } = capture;
      try {
        const segments = parseTimedText(responseText, lang);
        if (segments.length > 0) {
          this.lastTrackDiagnostic = `reused player timedtext capture (url: ${url})`;
          return segments;
        }
        this.lastTrackDiagnostic = `timedtext capture parse empty (content-type: ${contentType}, url: ${url})`;
        return void 0;
      } catch (err) {
        this.lastTrackDiagnostic = `timedtext capture parse failed: ${err instanceof Error ? err.message : String(err)} (content-type: ${contentType}, url: ${url})`;
        return void 0;
      }
    }
    /** 捕獲是否屬於當前視頻（無視頻 ID 上下文時保守接受；明確不同才拒絕）。 */
    captureMatchesCurrentVideo(capture) {
      const current = this.currentVideoId();
      if (!current) return true;
      if (!capture.videoId) return true;
      return capture.videoId === current;
    }
    /**
     * 等待播放器捕獲響應後複用（M1-43）。
     * 僅當 provider 支持 waitForCapture 時等待；否則立即返回 undefined 走直接 fetch。
     */
    async waitForCaptureReuse(lang) {
      if (!this.captureProvider?.waitForCapture) return void 0;
      let capture;
      try {
        capture = await this.captureProvider.waitForCapture(
          this.waitForCaptureTimeoutMs,
          this.currentVideoId()
        );
      } catch {
        this.lastTrackDiagnostic = `timedtext capture wait failed`;
        return void 0;
      }
      if (!capture || !capture.responseText) {
        this.lastTrackDiagnostic = `timedtext capture wait timeout (${this.waitForCaptureTimeoutMs} ms) \u2014 fall back to direct fetch` + (this.lastTrackDiagnostic?.includes("capture is for another video") ? ` (prior: ${this.lastTrackDiagnostic})` : "");
        return void 0;
      }
      try {
        const segments = parseTimedText(capture.responseText, lang);
        if (segments.length > 0) {
          this.lastTrackDiagnostic = `reused player timedtext capture after wait (url: ${capture.url})`;
          return segments;
        }
        this.lastTrackDiagnostic = `timedtext capture parse empty (content-type: ${capture.contentType}, url: ${capture.url})`;
        return void 0;
      } catch (err) {
        this.lastTrackDiagnostic = `timedtext capture parse failed: ${err instanceof Error ? err.message : String(err)} (content-type: ${capture.contentType}, url: ${capture.url})`;
        return void 0;
      }
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
    getLastTrackDiagnostic() {
      return this.captionSource.getLastTrackDiagnostic?.();
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
  var CHUNK_SIZE = 60;
  var MAX_RETRIES = 2;
  var RETRY_DELAYS_MS = [500, 1500];
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
      this.timeoutMs = opts.timeoutMs ?? 3e4;
    }
    opts;
    location = "cloud";
    timeoutMs;
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
        const chunkResult = await this.translateChunkWithRetry(chunk, req);
        accumulated.push(...chunkResult);
        emit({
          segments: [...accumulated],
          engineId: this.opts.engineId,
          degraded: false
        });
      }
    }
    /** 塊翻譯 + 快取 + 重試。瞬態失敗（transient）重試，永久失敗直接拋。 */
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
          const map = await this.translateChunkOnce(chunk, req);
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
    /** 塊翻譯一輪：fetch + parse；失敗拋 LLMRequestError（瞬態/永久按語義標記）。 */
    async translateChunkOnce(chunk, req) {
      const lines = chunk.map((s, i) => `${i}	${s.sourceText}`);
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
      return map;
    }
    /** 生成快取 key：model|targetLang|hash(塊源文)。 */
    cacheKey(chunk, targetLang) {
      return `${this.opts.model}|${targetLang}|${djb2Hash(chunk.map((s) => s.sourceText).join("\n"))}`;
    }
    /**
     * 直接 fetch 翻譯端點。
     * content script 在 ISOLATED world 有 host_permissions（manifest.json），
     * 可以直接 fetch localhost，不受 CORS 限制。
     * M1-52：AbortController 覆蓋 fetch+body 讀取全程——原實現收到響應頭後即
     * clearTimeout，body 流掛死時超時永遠不觸發（M1-47 用戶反饋的 connection lost 場景）。
     */
    async fetchDirectly(request) {
      diagLog("llm", "fetching directly to", request.endpoint);
      const startTime = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await globalThis.fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: controller.signal
        });
        const elapsed = Date.now() - startTime;
        diagLog("llm", "fetch completed in", elapsed, "ms, status =", res.status);
        let text;
        try {
          text = await res.text();
        } catch (err) {
          throw new LLMRequestError(
            `response body read failed: ${err instanceof Error ? err.message : String(err)}`,
            res.status,
            true
          );
        }
        return { ok: res.ok, status: res.status, body: text };
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

  // src/adapters/render/overlay-renderer.ts
  var NO_CUE_LOG_INTERVAL_MS = 5e3;
  var OverlayRenderer = class {
    root = null;
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
      captionSource: new FetchCaptionSource(
        globalThis.document,
        globalThis.fetch,
        opts.captionCaptureProvider
      ),
      watchUrlRe: opts.platformWatchRe
    });
    const translation = await buildTranslationProviders(config, opts.apiKeyStore);
    ensureLlmCacheInvalidationHook();
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
        // M1-51：debugLog 深合併——舊配置缺 debugLog 時補全鍵，避免 undefined 崩壞。
        debugLog: { ...DEFAULT_CONFIG.debugLog, ...patch.debugLog ?? {} }
      };
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
  async function recordDiagnostic(e) {
    const diag = extractDiagnostic(e);
    if (!diag) return;
    const record = {
      kind: diag.kind,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message: diag.message
    };
    console.warn(`[AI_Trans] translation degraded: ${diag.message}`);
    try {
      await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: record });
    } catch {
    }
  }

  // src/runtime/timedtext-bridge.ts
  var INTERCEPTOR_SCRIPT_URL = "src/runtime/yt-timedtext-interceptor.js";
  var CAPTURE_EVENT = "ai-trans:timedtext-capture";
  var POLL_INTERVAL_MS = 2e3;
  var VIDEO_SELECTOR = "video.html5-main-video, #mock-player video";
  var TimedTextBridge = class {
    latest = null;
    onMessageBound;
    injected = false;
    pollTimer = null;
    /** 等待捕獲的 Promise 解析器隊列（waitForCapture 多路等待）。 */
    waiters = /* @__PURE__ */ new Set();
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
      for (const w of this.waiters) w();
      this.waiters.clear();
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
    onMessage(event) {
      const data = event.data;
      if (!data || typeof data !== "object" || !data.__aiTrans) return;
      if (data.type === CAPTURE_EVENT) {
        const payload = data.payload;
        if (!payload || typeof payload.url !== "string" || typeof payload.responseText !== "string") return;
        this.latest = payload;
        this.notifyWaiters();
      }
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
  var store = new ChromeStorageConfigStore();
  var SubtitleController = class {
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
    pendingMountObserver = null;
    mountWaitTimer = null;
    // M1-51：調試旗標中繼重播定時器（跨 world 監聽器晚就位場景），restart/stop 清理（R4）。
    debugFlagRelayTimer = null;
    // SPA 換視頻監聽（M1-45）：YouTube 換視頻走 pushState，content-script 不會重載；
    // 偵測 URL 的 v 參數變化後熱重啟字幕管線。dispose 時必須解除/恢復（R4）。
    onUrlChangedBound;
    origPushState;
    origReplaceState;
    patchedHistory;
    lastVideoId;
    urlChangeTimer = null;
    /** 加載配置 → 組裝 → 掛載 → 啟動 Orchestrator。 */
    async start() {
      this.applyDebugFlags();
      this.bridge.inject();
      this.bridge.start();
      document.dispatchEvent(
        new CustomEvent("ai-trans:set-target-lang", {
          detail: { targetLang: this.config.targetLang }
        })
      );
      diagLog("content", "Sent set-target-lang message to MAIN world:", this.config.targetLang);
      const currentUrl = this.currentUrl();
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
      if (this.debugFlagRelayTimer !== null) {
        clearInterval(this.debugFlagRelayTimer);
        this.debugFlagRelayTimer = null;
      }
      this.unsubscribePlayback?.();
      this.unsubscribePlayback = null;
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
      globalThis.removeEventListener("popstate", this.onUrlChangedBound);
      if (this.patchedHistory) {
        history.pushState = this.origPushState;
        history.replaceState = this.origReplaceState;
      }
    }
    /** 偵測 URL 的 v 參數變化（SPA 換視頻）→ 熱重啟字幕管線（M1-45）。 */
    onUrlChanged() {
      if (this.urlChangeTimer !== null) return;
      const videoId = extractVideoId(window.location.href);
      if (videoId === this.lastVideoId) return;
      this.lastVideoId = videoId;
      this.urlChangeTimer = setTimeout(() => {
        this.urlChangeTimer = null;
        void this.restart().catch((err) => {
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
        diagLog("content", "cues updated, count:", this.cues.length, "calling scheduleDraw");
        this.scheduleDraw();
        return;
      }
      diagLog("content", "onEvent received", e.type, e.type === "engine-degraded" ? e.reason : "");
      void recordDiagnostic(e);
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

