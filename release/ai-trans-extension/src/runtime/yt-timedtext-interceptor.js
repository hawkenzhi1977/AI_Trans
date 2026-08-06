"use strict";
(() => {
  // src/runtime/yt-timedtext-interceptor.ts
  var TIMEDTEXT_CAPTURE_EVENT = "ai-trans:timedtext-capture";
  var TIMEDTEXT_REQUEST_EVENT = "ai-trans:timedtext-request";
  var INSTALL_FLAG = "__aiTransTimedtextInterceptorInstalled";
  function isTimedText(url) {
    try {
      const u = new URL(url, globalThis.location?.href ?? url);
      const hostOk = u.hostname.endsWith("youtube.com") || u.hostname === "localhost";
      return hostOk && u.pathname.includes("timedtext");
    } catch {
      return false;
    }
  }
  function emitCapture(url, responseText, contentType, location) {
    if (!responseText) return;
    const capture = {
      url,
      responseText,
      contentType: contentType || "unknown",
      capturedAt: Date.now()
    };
    const postMsg = globalThis.postMessage.bind(globalThis);
    postMsg(
      { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: capture },
      location.origin
    );
  }
  function install() {
    if (Reflect.get(globalThis, INSTALL_FLAG)) return;
    Reflect.set(globalThis, INSTALL_FLAG, true);
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, async, username, password) {
      const urlStr = typeof url === "string" ? url : url.href;
      if (isTimedText(urlStr)) {
        this.__aiTransUrl = urlStr;
      }
      return origOpen.apply(this, [method, url, async ?? true, username, password]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      const urlStr = this.__aiTransUrl;
      if (urlStr) {
        const onLoad = () => {
          this.removeEventListener("load", onLoad);
          try {
            const responseText = String(
              this.responseText ?? ""
            );
            const contentType = this.getResponseHeader?.("content-type") ?? "unknown";
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
      const captured = origFetch(input, init);
      void captured.then((res) => {
        try {
          const clone = res.clone();
          void clone.text().then((text) => {
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

