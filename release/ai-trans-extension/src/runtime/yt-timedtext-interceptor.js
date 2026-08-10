"use strict";
(() => {
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

  // src/infrastructure/debug-log.ts
  var flags = { ...DEBUG_LOG_OFF };
  function setDebugFlags(next) {
    flags = { ...DEBUG_LOG_OFF, ...next ?? {} };
  }
  function diagLog(category, ...args) {
    if (!flags[category]) return;
    console.log(`[AI_Trans:diag][${category}]`, ...args);
  }

  // src/runtime/yt-timedtext-interceptor.ts
  var TIMEDTEXT_CAPTURE_EVENT = "ai-trans:timedtext-capture";
  var TIMEDTEXT_REQUEST_EVENT = "ai-trans:timedtext-request";
  var SET_TARGET_LANG_EVENT = "ai-trans:set-target-lang";
  var SET_DEBUG_FLAGS_EVENT = "ai-trans:set-debug-flags";
  var VIDEO_CHANGED_EVENT = "ai-trans:video-changed";
  var INSTALL_FLAG = "__aiTransTimedtextInterceptorInstalled";
  function isTimedText(url) {
    try {
      const u = new URL(url, globalThis.location?.href ?? url);
      return u.pathname.includes("timedtext");
    } catch {
      return false;
    }
  }
  function readXhrResponseText(xhr) {
    const responseType = xhr.responseType ?? "";
    if (responseType === "" || responseType === "text") {
      return String(xhr.responseText ?? "");
    }
    const response = xhr.response;
    if (response == null) return "";
    if (typeof response === "string") return response;
    if (responseType === "json") {
      try {
        return JSON.stringify(response);
      } catch {
        return "";
      }
    }
    if (responseType === "arraybuffer" && response instanceof ArrayBuffer) {
      try {
        return new TextDecoder("utf-8").decode(new Uint8Array(response));
      } catch {
        return "";
      }
    }
    return "";
  }
  function extractVideoId(url) {
    try {
      const u = new URL(url, globalThis.location?.href ?? url);
      return u.searchParams.get("v") ?? "";
    } catch {
      return "";
    }
  }
  function emitCapture(url, responseText, contentType, location) {
    if (!responseText) {
      diagLog("interceptor", "emitCapture: empty response, skipping");
      return;
    }
    captureRequestCount++;
    const capture = {
      url,
      responseText,
      contentType: contentType || "unknown",
      capturedAt: Date.now(),
      videoId: extractVideoId(url)
    };
    diagLog("interceptor", "emitCapture: success, captureRequestCount:", captureRequestCount, "videoId:", capture.videoId);
    lastCapture = capture;
    Reflect.set(globalThis, "__aiTransTimedtextRequests", captureRequestCount);
    Reflect.set(globalThis, "__aiTransTimedtextLastCapture", capture);
    const postMsg = globalThis.postMessage.bind(globalThis);
    postMsg(
      { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: capture },
      location.origin
    );
  }
  var lastCapture = null;
  var captureRequestCount = 0;
  function startReplay() {
    const REPLAY_INTERVAL_MS = 1500;
    setInterval(() => {
      if (!lastCapture) return;
      const postMsg = globalThis.postMessage.bind(globalThis);
      postMsg(
        { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: lastCapture },
        globalThis.location.origin
      );
    }, REPLAY_INTERVAL_MS);
  }
  var targetLang = null;
  function pickTargetTrack(tracklist) {
    const manual = tracklist.find((t) => t.kind !== "asr");
    return manual ?? tracklist[0];
  }
  var captionModuleDriven = false;
  function getCaptionTracksFromPlayerResponse() {
    const scripts = document.querySelectorAll("script:not([src])");
    for (const el of Array.from(scripts)) {
      const text = el.textContent ?? "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      let jsonStr;
      const assignMatch = /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
      if (assignMatch) {
        jsonStr = assignMatch[1];
      } else if (text.trim().startsWith("{")) {
        jsonStr = text.trim();
      }
      if (!jsonStr) continue;
      try {
        const data = JSON.parse(jsonStr);
        const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!Array.isArray(tracks)) continue;
        const currentVid = extractVideoId(globalThis.location?.href ?? "");
        const playerVid = data?.videoDetails?.videoId ?? "";
        if (currentVid && playerVid && currentVid !== playerVid) {
          diagLog("interceptor", "getCaptionTracksFromPlayerResponse: videoId mismatch, current:", currentVid, "player:", playerVid, "- stale data");
          return void 0;
        }
        return tracks;
      } catch {
      }
    }
    return void 0;
  }
  function ensureCaptionModuleLoaded() {
    if (captionModuleDriven) return;
    if (lastCapture) {
      const captureVid = lastCapture.videoId ?? "";
      const currentVid = extractVideoId(globalThis.location?.href ?? "");
      if (currentVid && captureVid === currentVid) {
        diagLog("interceptor", "lastCapture already has current video data (videoId:", currentVid, "), skipping caption module drive");
        captionModuleDriven = true;
        return;
      }
    }
    const player = document.getElementById("movie_player");
    if (!player) {
      diagLog("interceptor", "Player element not found");
      return;
    }
    if (typeof player.loadModule !== "function" || typeof player.setOption !== "function") {
      diagLog("interceptor", "Player API not available");
      return;
    }
    try {
      player.loadModule("captions");
    } catch {
    }
    let tracklist;
    let source = "unknown";
    const domTracks = getCaptionTracksFromPlayerResponse();
    if (domTracks && domTracks.length > 0) {
      tracklist = domTracks;
      source = "ytInitialPlayerResponse (DOM)";
      diagLog("interceptor", "Got tracks from ytInitialPlayerResponse:", domTracks.length, "tracks");
    } else if (typeof player.getOption === "function") {
      try {
        const raw = player.getOption("captions", "tracklist");
        diagLog("interceptor", "getOption tracklist:", raw, "isArray:", Array.isArray(raw));
        if (Array.isArray(raw) && raw.length > 0) {
          tracklist = raw;
          source = "player.getOption";
        }
      } catch (err) {
        diagLog("interceptor", "getOption error:", err);
      }
    }
    if (!tracklist || tracklist.length === 0) {
      diagLog("interceptor", "No caption tracks available (video may have no captions)");
      Reflect.set(globalThis, "__aiTransCaptionTracks", 0);
      return;
    }
    diagLog("interceptor", "Found", tracklist.length, "caption tracks from", source);
    Reflect.set(globalThis, "__aiTransCaptionTracks", tracklist.length);
    const track = pickTargetTrack(tracklist);
    try {
      player.setOption("captions", "track", track);
      captionModuleDriven = true;
      diagLog("interceptor", "Caption module driven successfully, selected track:", track);
      setTimeout(() => {
        try {
          player.setOption("captions", "track", {});
          diagLog("interceptor", "Caption track reset to suppress native rendering");
        } catch {
        }
      }, 3e3);
    } catch (err) {
      diagLog("interceptor", "setOption error:", err);
    }
  }
  function startCaptionModuleDriver() {
    const RETRY_INTERVAL_MS = 1e3;
    const MAX_RETRIES = 60;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      ensureCaptionModuleLoaded();
      if (captionModuleDriven || attempts >= MAX_RETRIES) {
        clearInterval(timer);
      }
    }, RETRY_INTERVAL_MS);
  }
  function resetAndRedriveCaptionModule() {
    captionModuleDriven = false;
    ensureCaptionModuleLoaded();
    if (!captionModuleDriven) {
      startCaptionModuleDriver();
    }
  }
  function install() {
    if (Reflect.get(globalThis, INSTALL_FLAG)) return;
    Reflect.set(globalThis, INSTALL_FLAG, true);
    startReplay();
    const onSetTargetLang = (ev) => {
      const detail = ev.detail;
      targetLang = typeof detail?.targetLang === "string" ? detail.targetLang : null;
      Reflect.set(globalThis, "__aiTransTargetLang", targetLang);
      diagLog("interceptor", "Received set-target-lang message, targetLang:", targetLang);
      resetAndRedriveCaptionModule();
    };
    document.addEventListener("ai-trans:set-target-lang", onSetTargetLang);
    const onSetDebugFlags = (ev) => {
      const detail = ev.detail;
      setDebugFlags(detail?.flags);
      diagLog("interceptor", "debug flags updated:", detail?.flags);
    };
    document.addEventListener(SET_DEBUG_FLAGS_EVENT, onSetDebugFlags);
    const onVideoChanged = () => {
      diagLog("interceptor", "video-changed event received, clearing lastCapture and resetting captionModuleDriven");
      lastCapture = null;
      Reflect.set(globalThis, "__aiTransTimedtextLastCapture", null);
      captionModuleDriven = false;
      resetAndRedriveCaptionModule();
    };
    document.addEventListener(VIDEO_CHANGED_EVENT, onVideoChanged);
    startCaptionModuleDriver();
    Reflect.set(globalThis, "__aiTransTimedtextRequests", 0);
    Reflect.set(globalThis, "__aiTransTimedtextLastCapture", null);
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, async, username, password) {
      const urlStr = typeof url === "string" ? url : url.href;
      if (isTimedText(urlStr)) {
        diagLog("interceptor", "XHR timedtext request detected:", urlStr);
        this.__aiTransUrl = urlStr;
      }
      return origOpen.apply(this, [method, url, async ?? true, username, password]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const urlStr = this.__aiTransUrl;
      if (urlStr) {
        diagLog("interceptor", "XHR timedtext request sending:", urlStr);
        const onLoad = () => {
          this.removeEventListener("load", onLoad);
          try {
            const responseType = this.responseType ?? "";
            const status = this.status ?? 0;
            diagLog("interceptor", "XHR timedtext onLoad: status:", status, "responseType:", responseType);
            const responseText = readXhrResponseText(this);
            const contentType = this.getResponseHeader?.("content-type") ?? "unknown";
            diagLog("interceptor", "XHR timedtext response received, length:", responseText.length, "content-type:", contentType);
            emitCapture(urlStr, responseText, contentType, globalThis.location);
          } catch {
          }
        };
        this.addEventListener("load", onLoad);
      }
      return origSend.apply(this, args);
    };
    const origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function(input, init) {
      let urlStr;
      try {
        urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      } catch {
        return origFetch(input, init);
      }
      if (!isTimedText(urlStr)) return origFetch(input, init);
      diagLog("interceptor", "fetch timedtext request detected:", urlStr);
      const captured = origFetch(input, init);
      void captured.then((res) => {
        diagLog("interceptor", "fetch timedtext response received, status:", res.status);
        try {
          const clone = res.clone();
          void clone.text().then((text) => {
            diagLog("interceptor", "fetch timedtext response body length:", text.length);
            emitCapture(
              urlStr,
              text,
              res.headers.get("content-type") ?? "unknown",
              globalThis.location
            );
          });
        } catch {
        }
      });
      return captured;
    };
  }
  install();
})();

