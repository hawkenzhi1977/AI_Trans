"use strict";
(() => {
  // src/runtime/yt-timedtext-interceptor.ts
  var TIMEDTEXT_CAPTURE_EVENT = "ai-trans:timedtext-capture";
  var TIMEDTEXT_REQUEST_EVENT = "ai-trans:timedtext-request";
  var INSTALL_FLAG = "__aiTransTimedtextInterceptorInstalled";
  function install() {
    if (Reflect.get(globalThis, INSTALL_FLAG)) return;
    Reflect.set(globalThis, INSTALL_FLAG, true);
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const isTimedText = (url) => {
      try {
        const u = new URL(url, globalThis.location?.href ?? url);
        return u.hostname.endsWith("youtube.com") && u.pathname.includes("timedtext");
      } catch {
        return false;
      }
    };
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
            const responseText = String(this.responseText ?? "");
            if (!responseText) return;
            const capture = {
              url: urlStr,
              responseText,
              contentType: this.getResponseHeader?.("content-type") ?? "unknown",
              capturedAt: Date.now()
            };
            const postMsg = globalThis.postMessage.bind(globalThis);
            postMsg(
              { __aiTrans: true, type: TIMEDTEXT_CAPTURE_EVENT, payload: capture },
              globalThis.location.origin
            );
          } catch {
          }
        };
        this.addEventListener("load", onLoad);
      }
      return origSend.apply(this, args);
    };
  }
  install();
})();

