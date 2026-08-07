"use strict";
(() => {
  // src/runtime/yt-timedtext-interceptor.ts
  var TIMEDTEXT_CAPTURE_EVENT = "ai-trans:timedtext-capture";
  var TIMEDTEXT_REQUEST_EVENT = "ai-trans:timedtext-request";
  var SET_TARGET_LANG_EVENT = "ai-trans:set-target-lang";
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
      console.log("[AI_Trans Interceptor] emitCapture: empty response, skipping");
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
    console.log("[AI_Trans Interceptor] emitCapture: success, captureRequestCount:", captureRequestCount, "videoId:", capture.videoId);
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
  function ensureCaptionModuleLoaded() {
    if (captionModuleDriven) return;
    const player = document.getElementById("movie_player");
    if (!player) {
      console.log("[AI_Trans Interceptor] Player element not found");
      return;
    }
    if (typeof player.loadModule !== "function" || typeof player.getOption !== "function" || typeof player.setOption !== "function") {
      console.log("[AI_Trans Interceptor] Player API not available");
      return;
    }
    try {
      player.loadModule("captions");
    } catch {
    }
    let tracklist;
    try {
      const raw = player.getOption("captions", "tracklist");
      console.log("[AI_Trans Interceptor] Tracklist:", raw, "isArray:", Array.isArray(raw));
      if (Array.isArray(raw)) tracklist = raw;
    } catch (err) {
      console.log("[AI_Trans Interceptor] getOption error:", err);
      return;
    }
    if (!tracklist || tracklist.length === 0) {
      console.log("[AI_Trans Interceptor] No caption tracks available");
      Reflect.set(globalThis, "__aiTransCaptionTracks", 0);
      return;
    }
    console.log("[AI_Trans Interceptor] Found", tracklist.length, "caption tracks");
    Reflect.set(globalThis, "__aiTransCaptionTracks", tracklist.length);
    const track = pickTargetTrack(tracklist);
    try {
      player.setOption("captions", "track", track);
      captionModuleDriven = true;
      console.log("[AI_Trans Interceptor] Caption module driven successfully, selected track:", track);
      setTimeout(() => {
        try {
          player.setOption("captions", "track", {});
          console.log("[AI_Trans Interceptor] Caption track reset to suppress native rendering");
        } catch {
        }
      }, 3e3);
    } catch (err) {
      console.log("[AI_Trans Interceptor] setOption error:", err);
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
      console.log("[AI_Trans Interceptor] Received set-target-lang message, targetLang:", targetLang);
      resetAndRedriveCaptionModule();
    };
    document.addEventListener("ai-trans:set-target-lang", onSetTargetLang);
    startCaptionModuleDriver();
    Reflect.set(globalThis, "__aiTransTimedtextRequests", 0);
    Reflect.set(globalThis, "__aiTransTimedtextLastCapture", null);
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, async, username, password) {
      const urlStr = typeof url === "string" ? url : url.href;
      if (isTimedText(urlStr)) {
        console.log("[AI_Trans Interceptor] XHR timedtext request detected:", urlStr);
        this.__aiTransUrl = urlStr;
      }
      return origOpen.apply(this, [method, url, async ?? true, username, password]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const urlStr = this.__aiTransUrl;
      if (urlStr) {
        console.log("[AI_Trans Interceptor] XHR timedtext request sending:", urlStr);
        const onLoad = () => {
          this.removeEventListener("load", onLoad);
          try {
            const responseText = readXhrResponseText(this);
            const contentType = this.getResponseHeader?.("content-type") ?? "unknown";
            console.log("[AI_Trans Interceptor] XHR timedtext response received, length:", responseText.length, "content-type:", contentType);
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
      console.log("[AI_Trans Interceptor] fetch timedtext request detected:", urlStr);
      const captured = origFetch(input, init);
      void captured.then((res) => {
        console.log("[AI_Trans Interceptor] fetch timedtext response received, status:", res.status);
        try {
          const clone = res.clone();
          void clone.text().then((text) => {
            console.log("[AI_Trans Interceptor] fetch timedtext response body length:", text.length);
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

