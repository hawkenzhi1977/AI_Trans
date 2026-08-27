# AI_Trans

**Real-time translated subtitles for YouTube — a Chrome MV3 extension.**

AI_Trans grabs a video's captions (or, later, transcribes its audio), translates them with a configurable engine (cloud LLM or local model), and renders the result as an overlay on the player — without leaving the page.

繁體中文說明見 [README.zh-Hant.md](./README.zh-Hant.md).

---

## Features

### Implemented (Milestone M1)

- **Native caption translation** — detects and fetches YouTube's native caption track, translates it, and overlays it on the player. Handles all of YouTube's timedtext formats: it requests the stable `fmt=json3` JSON, and falls back to parsing `srv3` XML (`<timedtext><p t d><s>`) or the legacy `<transcript><text>` XML; malformed HTML (login/error pages) is detected as a parse error instead of being misreported as "no captions". **Works with YouTube's `pot` (proof-of-origin token) protection on `/api/timedtext`**: when the player itself requests captions (it uses a token-validated request that the extension can't reproduce), the extension captures that response in the page's main world and reuses it, so captions load even on token-protected requests. The interceptor is injected at `document_start` in the main world (declared in the manifest), so it is in place before the player's first caption request — including on cached/reloaded pages. **SPA video switching** — switching videos without a page reload (YouTube's recommended playlist / sidebar navigation) is detected via URL changes and the subtitle pipeline restarts automatically for the new video; stale captions from a previous video are never reused. **Cross-world communication via CustomEvent** — the content script (isolated world) and the interceptor (main world) communicate via `CustomEvent` dispatched on `document`, avoiding the unreliability of `postMessage` across isolated worlds. **Caption module driver with enhanced retry** — the interceptor drives YouTube's caption module with up to 60 retries (60 seconds) and immediate trigger on target language change, ensuring captions load even on slow player initialization. **Event-driven late-capture retry** — if a token-validated capture arrives *after* the pipeline has already fallen back to "no captions" (the player's token re-drive chain can exceed the 15s capture window even though the response eventually succeeds), the extension treats the late capture as an event: it re-runs the caption pipeline automatically (up to 3 times, 5s cooldown) instead of staying permanently blank; success resolves back to native captions, and a failed retry records a `native-capture-late-retry` diagnostic.
- **Overlay subtitle rendering** — monolingual or bilingual (source + translation), rendered on a dedicated overlay layer aligned to playback time.
- **Playback-synced subtitles** — subtitles follow current time, pause, and seek via media events + `requestAnimationFrame`.
- **Configurable translation engine** — cloud LLM (OpenAI-compatible `/chat/completions`) as primary, traditional MT as fallback; endpoint, model, and API key are user-configured. API keys are stored separately from the config object.
- **Local LLM service support** — works with local OpenAI-compatible servers (mlx / omlx / LM Studio / Ollama): the endpoint field accepts either a Base URL (`http://127.0.0.1:8000/v1`) or a full `/chat/completions` path (auto-normalized); `http://127.0.0.1/*` and `http://localhost/*` host permissions are granted; reasoning-model `<think>` blocks are stripped from the reply; requests use a **two-phase timeout** — 30s for response headers, 5 min for the response body (long local-LLM generations aren't cut off); config changes hot-reload across contexts via `chrome.storage.onChanged`.
- **Target language & subtitle style** — pick target language, display mode (mono/bilingual), font size, color, and background.
- **Options & Popup UI** — full settings page plus a quick popup (status + reload).
- **Reliability-hardened content script** — host-method binding (no "Illegal invocation"), leak-free subscriptions on config hot-reload, tolerant external JSON parsing (see `AGENTS.md` §5).
- **Translation-failure diagnostics** — degrade/error events are no longer silently swallowed by the pipeline: the failure reason is persisted to `chrome.storage.local` and **always shown** on the Popup's "last failure" line (no record → shows "none", so you can always confirm it's working), plus a `console.warn` breadcrumb. When **no caption strategy can take over** (e.g. the video's native caption track can't be fetched — different from a translation failure), that's also reported with the underlying reason, so "no captions found" and "translation failed" are distinguishable. A **"Test Connection" button** in the Popup sends a minimal live request to the configured endpoint — verifying reachability, model name, and response structure in one click. The Popup's translation status line also shows the **actual model name in effect** (local mode), making it easy to confirm whether a save actually updated storage. Every external interface call leaves **evidence-based diagnostics** instead of guesswork: caption fetch failures report the actual HTTP status, content-type, and a body snippet; a malformed LLM response (non-JSON body, missing/empty `choices`) is treated as a failure and downgraded with a traceable event rather than silently falling back to the original text; a player that never appears after 15s raises a `player-not-found` error; and configuration/API-key read failures in the Popup, Options page, and service worker are shown explicitly instead of failing silently.
- **Translation-failure fallback** — when the LLM translation service fails (e.g. connection lost, timeout), the extension **falls back to displaying the original (source) subtitles** instead of showing nothing. An `engine-degraded` event is emitted so the Popup can display the degradation reason. Users prefer seeing original subtitles over a blank screen.
- **Low-latency chunked translation** — long videos are translated in chunks (`CHUNK_SIZE=60` segments) that stream in progressively: the first chunk appears within seconds and later chunks update the overlay incrementally, instead of waiting minutes for the whole video. Chunk results are cached (LRU, up to 100 entries, keyed by model + language + content hash) so replays, language switches, and tab reloads don't re-request; the cache is invalidated automatically when engine config changes. Transient failures (network aborts, timeouts, HTTP 429/5xx, body read or JSON errors) are retried up to 2× with backoff, and a chunk that exhausts retries falls back to showing its **original text** without blocking the rest of the video — while permanent errors (e.g. HTTP 400, malformed response) still fail fast and trigger the pipeline degradation with a traceable diagnostic.
- **Debug logging gate** — console logs are organized into nine categories (overlay / llm / capture / pipeline / strategy / content / bridge / interceptor / local-onnx) that are **all off by default**; enable individual categories in Settings → Debug logging when diagnosing an issue. Logged lines are prefixed `[AI_Trans:diag][category]` for easy filtering. Error and degradation messages are **not** gated — they always appear, so the "last failure" line and `console.warn` breadcrumbs stay reliable even with debug logging disabled.

### Implemented (Milestone M2)

- **Real-time ASR for captionless videos** (`F-06`, `F-07`) — captures tab audio via `chrome.tabCapture` and runs streaming ASR + translation for videos without native captions. **Offscreen Document architecture** — ASR runs in a dedicated offscreen document (declared in manifest) to avoid service worker suspension; communicates with the content script via `chrome.runtime.connect` port (long-lived connection, not one-shot messaging). **Tab audio capture** — `TabCaptureAudioSource` adapter captures the tab's audio stream; user authorization via Popup's "Enable ASR" button triggers `chrome.tabCapture.getMediaStream` with proper lifecycle management (start/stop events). **Energy-based VAD** — `EnergyVAD` (root-mean-square threshold, no external dependencies) splits continuous audio into speech segments by detecting active speech vs silence, enabling chunked ASR processing. **Local Whisper ASR** — `LocalWhisperASR` adapter uses `@huggingface/transformers` (transformers.js v3, WASM/WebGPU) to run Whisper models locally; model files are downloaded on-demand and cached in IndexedDB (not `chrome.storage.local`, which has a 5MB limit — Whisper tiny is ~150MB). **Cloud ASR** — `CloudASR` adapter supports both OpenAI Whisper API (multipart POST to `/v1/audio/transcriptions`) and Deepgram (WebSocket streaming); endpoint URL auto-detection (contains `deepgram` → WebSocket, otherwise → OpenAI-compatible). **Streaming ASR interface** — `ASRPipeline.transcribeStream()` yields incremental segments; `RealtimeASRStrategy` orchestrates the full flow: audio capture → VAD segmentation → ASR transcription → translation → overlay rendering. **Provisional subtitle correction** — intermediate ASR results are shown as "provisional" subtitles (distinct styling) and corrected when final results arrive, providing immediate feedback. **Performance monitoring** — `PerfMetrics` tracks ASR latency with a sliding window (100 samples), computes P50/P95 statistics, and triggers automatic downgrade (e.g., from local Whisper to cloud ASR, or from high-quality to lightweight model) when real-time factor exceeds 1.0 for 30s. **Model tier configuration** — Options UI supports selecting model tier (tiny/base/small/medium for local Whisper; cloud endpoint + model ID); custom local ASR models (e.g., vibevoice) are supported via endpoint configuration. **Comprehensive diagnostics** — ASR pipeline failures (tab capture authorization denied, capture failed, offscreen communication error, ASR engine failure, performance downgrade, VAD silence split, model download error, endpoint identification) all emit traceable diagnostic events visible in Popup's "last failure" line.
- **Local ONNX translation fallback** (`F-14`) — when the cloud LLM API fails (network errors, quota exhaustion, offline), the extension automatically falls back to a local ONNX model for fully offline translation. **Single unified model**: `onnx-community/Qwen2.5-0.5B-Instruct` (INT4 ONNX, ~750MB, high quality) with **configurable chunk size** (3/4/5) for performance tuning — smaller chunks for low-config machines, larger chunks for better throughput. Uses unified ChatML prompt format with text-generation pipeline. **Architecture**: a new `LocalONNXTranslationProvider` adapter implements the `TranslationProvider` port, sending inference requests via Chrome Message Bus to the Service Worker, which forwards them to the Offscreen Document (with full DOM and WASM support) to execute ONNX Runtime Web inference. The ONNX Runtime WASM binaries are bundled into the extension (no external CDN dependency). **Primary-engine support**: the Options "Engine type" selector can choose "Local ONNX model (offline)" as the primary translation engine, enabling fully offline translation without any cloud API; on failure it still degrades to MT or original text. **Options UI**: a new "Local Fallback Model" section displays the model name (read-only), **chunk size selector** (3/4/5), status badge (`Not downloaded` / `Downloading xx%` / `Ready` / `Preloading…` / `Preloaded (in memory)` / `Download failed`), download progress bar (real-time byte percentage and speed), and "Download Model" / **"Preload Model"** / "Clear Cache" buttons. **Model preload**: a "Preload Model" button (OMLX-style manual preload) loads the model into memory on demand — clickable once the model is downloaded, showing "Preloaded (in memory)" on success. In addition, the Orchestrator automatically triggers a non-blocking `warmup()` on the primary translation engine at startup (triggered loading), so the model is loaded before the first translation request. The model loads only once per Offscreen Document lifetime — subsequent videos reuse it without reloading; if Chrome destroys the Offscreen Document, the model is lazily restored from cache. **Fallback chain**: `TranslationConfig.fallbackType` adds `'local-onnx'` option; `Orchestrator` prioritizes `local-onnx` as fallback (`local-onnx > mt > undefined`). If the model isn't downloaded, the provider throws an error with `local-onnx-not-downloaded` diagnostic, and the pipeline continues degrading to MT or original text. **Cache-clear consistency**: "Clear cache → download again" is stable — clearing the cache also invalidates any in-flight stale load (generation counter invalidation, releasing ORT memory), and the download runs as a fresh load reporting real progress; if a download is interrupted by "Clear Cache", Options shows a retryable `local-onnx-download-stale-load` hint, and clicking "Download Model" again works. **True progressive streaming** — `translateStream` emits cumulative results chunk by chunk (first chunk reaches `segments-ready` within seconds, subsequent chunks via `segments-updated`, same semantics as the LLM provider); long videos no longer stay blank for minutes. **Echo diagnostics** — when the model echoes its input, the diagnostic now embeds the raw `generated_text` (first 200 chars) plus parse statistics (`parsed x/N`) and inference time, and each translated chunk reports an `echoed` flag aggregated into a `local-onnx-echo-chunks` diagnostic, so the popup's "last failure" can tell a genuine echo from a parse miss. Diagnostics only — no automatic degradation behavior. **WebGPU inference backend (M2-26)** — the local ONNX *translation* pipeline loads **webgpu-first**: model weights are kept in GPU VRAM (JS heap drops from ~500MB to ~50–100MB), which keeps the shared extension render process alive so the popup stays responsive even after the model is loaded; if WebGPU is unavailable it transparently falls back to WASM (weights in JS heap) and records a `local-onnx-webgpu-fallback` diagnostic. The local Whisper *ASR* pipeline stays on WASM (small models, low heap pressure).

### Planned (later milestones)

- **M3 — Look-ahead pre-buffering** (`F-08`): for captionless-but-prefetchable videos, transcribe buffered audio ahead of playback (higher risk / optimization).
- **Additional platforms** beyond YouTube.

> M1 (native-caption path) and M2 (real-time ASR) are production-ready. The three-tier subtitle strategy (native → pre-buffer ASR → real-time ASR) is two-thirds complete; see `doc/`.

---

## Option 1 — Use the prebuilt release (no build needed)

Prebuilt artifacts live in [`release/`](./release/):

- `release/ai-trans-extension/` — unpacked extension folder (recommended).
- `release/ai-trans-extension-v0.5.0.zip` — zipped archive.

Loading is **identical on Windows, macOS, and Linux** and on any Chromium browser (Chrome / Edge / Brave):

1. If you downloaded the zip, unzip it to get the `ai-trans-extension/` folder.
2. Open your browser and navigate to `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the `ai-trans-extension/` folder (the one that contains `manifest.json`).
6. Open any YouTube watch page: `https://www.youtube.com/watch?v=...`.
7. Click the **AI_Trans** toolbar icon → **Settings** to choose the engine, target language, and enter your API key.

The only per-OS difference is the file picker dialog; the extension itself is platform-agnostic.

> The prebuilt release targets `https://www.youtube.com/*` only. To translate a video, the target language and (for cloud LLM) a valid API key must be set in Settings; otherwise it falls back to the MT dictionary.

---

## Option 2 — Build the release from source (Windows / macOS / Linux)

### Prerequisites

- **Node.js ≥ 20** (includes npm). Verify with `node -v`.
- Git (to clone the repo).
- Optional: a `zip` CLI for the archive step. If missing, the unpacked folder is still produced and the zip step is skipped.
  - macOS/Linux: usually preinstalled.
  - Windows: use Git Bash / WSL, or install `zip`; without it you still get `release/ai-trans-extension/`.

### Steps (same commands on all platforms)

```bash
# 1. Get the code
git clone <repository-url>
cd AI_Trans

# 2. Install dependencies
npm install

# 3. Build the release artifacts into release/
npm run release
```

This runs typecheck → esbuild bundling → static copy → clean packaging, and produces:

- `release/ai-trans-extension/` — loadable unpacked extension.
- `release/ai-trans-extension-v<version>.zip` — distributable archive (if `zip` is available).

Then load `release/ai-trans-extension/` via **Load unpacked** (see Option 1, steps 2–7).

### Other useful commands

```bash
npm run build        # production build into dist/ (typecheck + bundle + copy)
npm run typecheck    # TypeScript type check only
npm run lint         # ESLint
npm run test:all     # full suite: build → unit + integration + contract → E2E → report
npm run test:ci      # unit + integration + contract (no E2E)
npm run test:e2e     # Playwright E2E (requires a build first)
```

> Windows note: the scripts are cross-platform Node scripts. Run the commands in PowerShell, CMD, Git Bash, or WSL. The `build:test` script uses an inline env var (`TEST_PROFILE=1`) that works in POSIX shells; on plain Windows CMD/PowerShell prefer WSL/Git Bash for `test:all`, or set the variable manually.

---

## Configuration

Open the extension's **Settings** (Options page) to set:

- **Translation engine**: cloud LLM / local / local ONNX (offline) / MT, model, endpoint, API key, fallback.
- **ASR engine**: local Whisper / cloud, model tier, endpoint, custom model path.
- **Target language**, **display mode** (mono/bilingual), **performance profile**.
- **Subtitle style**: font size, color, background.
- **Debug logging** (for diagnosing issues): toggle individual categories (overlay / llm / capture / pipeline / strategy / content / bridge / interceptor / local-onnx). All off by default.

API keys are written to a separate secure storage slot and are never embedded into the plain config object.

### Using a local LLM (mlx / omlx / LM Studio / Ollama)

1. Set **Translation engine** to `local` and enter the model ID your server exposes.
2. For **endpoint**, either the Base URL (`http://127.0.0.1:8000/v1`) or the full path (`http://127.0.0.1:8000/v1/chat/completions`) works — it is auto-normalized.
3. Enter the API key if your server requires one (any non-empty string otherwise).
4. Save. The content script hot-reloads the config; if a YouTube tab is already open, the change applies without a manual reload.

> **Reasoning models**: models that emit long `<think>` reasoning are supported (the `<think>` block is stripped). With the two-phase timeout, slow generations are given up to 5 min for the response body (only a stalled/unreachable server hits the 30s header timeout), but a single translation can still take 30–40s. For live subtitles prefer a non-reasoning (instruct) model.

> **Recommended translation models**: for real-time subtitles, pick a fast, translation-oriented (MT) or small instruct model rather than a large general-purpose one — chunked translation still starts from the video's beginning, so a slow model means captions lag behind when you seek far ahead. Well-tested choices:
> - **Tencent Hunyuan translation models** — `HY-MT1.5-1.8B` / `HY-MT2-1.8B`: purpose-built machine-translation models (~1.8B params), very fast on a local server; `HY-MT2-1.8B` is the newer generation.
> - **Qwen small instruct models** — `Qwen2.5-3B-Instruct` / `Qwen2.5-7B-Instruct`: general-purpose but small, good translation quality with acceptable speed; use 3B for lower-latency setups, 7B when quality matters more.
> Enter the model ID exactly as your server exposes it. Avoid ASR/speech-to-text models (e.g. VibeVoice-ASR) — they use `/v1/audio/transcriptions`, not `/v1/chat/completions`, and the connection test will fail with HTTP 400.

> **Ollama users**: Chrome extensions send requests with `Origin: chrome-extension://<id>`, which Ollama 0.32+ rejects by default (HTTP 403 with empty body). To fix this, set the environment variable `OLLAMA_ORIGINS=chrome-extension://*` or `OLLAMA_ORIGINS=.` (allow all origins) before starting Ollama.

> **Which engine should I use?** — **Cloud API** (best quality, zero local resources, needs network) → **Ollama/llama.cpp local service** (good quality, native speed, private, <400MB memory) → **Local ONNX Large** (fully offline, free, ~750MB, but slower and lower quality than native) → **Local ONNX Small** (for low-config machines, ~750MB, INT4, chunk size=3) → **MT** (instant, no setup, but the lowest quality; best as a last-resort fallback). For live subtitles, prefer a fast translation-oriented (MT) or small instruct model over a large general-purpose one, and for local servers avoid ASR models (they expose `/v1/audio/transcriptions`, not `/chat/completions`).

> **Local ONNX — latency & memory limits**: the local model runs entirely inside your browser. First use downloads the model files; after download, the **first translation can take 30–60s** while the model loads into memory — click **Preload Model** in Settings (or rely on the automatic background preload) so first-response latency stays near-instant. Translation is processed in chunks (3–5 segments per chunk depending on tier), so on very long videos the full translation takes a while, and a single session is hard-capped at **10 minutes** to keep the extension stable. Memory footprint varies by backend: WASM mode (default) uses ~500–750MB JS heap depending on model; WebGPU mode moves weights to VRAM (~50–100MB JS heap + GPU VRAM). On a low-RAM machine, prefer cloud or local-LLM engines.

> **Local ONNX model tier selection guide**: the extension offers two model tiers for different hardware capabilities:
> - **Large (Qwen2.5-0.5B-Instruct, ~750MB)** — **Recommended default**. Highest translation quality, INT4 quantization, chunk size=5. Uses modern Decoder-only architecture with BPE tokenizer and unified ChatML prompt format. Best for machines with ≥8GB RAM and WebGPU support.
> - **Small (Qwen2-0.5B-Instruct-ONNX, ~750MB)** — For low-config machines. INT4 quantization, chunk size=3. Same unified ChatML prompt format and text-generation pipeline as Large, with smaller chunk size for lower memory pressure during inference.
>
> **Tier switching behavior**: when you change the model tier in Settings, the extension automatically clears the old tier's cached files and memory resources, then refreshes the UI to show the new tier's download status. You'll need to re-download the newly selected tier if it hasn't been downloaded before.

> **⚠️ ONNX mode inherent limitations**: the browser-based ONNX runtime has fundamental constraints compared to native inference:
> - **WASM single-threaded**: browser extensions lack multi-threaded SIMD optimization; inference runs single-threaded even on multi-core CPUs.
> - **JS heap limits**: the extension shares the renderer process's JS heap with popup/options pages; large models can cause memory pressure.
> - **Quantization precision loss**: INT8/Q8 quantization in WASM loses more precision than native INT4/INT8, especially for Seq2Seq translation models.
> - **No native CPU optimizations**: unlike llama.cpp/Ollama which use AVX2/NEON multi-threading, browser WASM is 5–10× slower for the same model.
>
> **For low-config machines, we strongly recommend using external local model services (Ollama/llama.cpp) or cloud APIs instead of ONNX**:
> - **Ollama + Qwen2.5-0.5B (Q4_K_M)**: native C++ inference with CPU AVX2/NEON multi-threading, <400MB memory, 5–10× faster than browser WASM. Configure as "Local LLM service" with endpoint `http://127.0.0.1:11434/v1`.
> - **Cloud APIs (Groq, SiliconFlow, Cloudflare Workers AI, Gemini API)**: zero local CPU/memory overhead, 300–800ms end-to-end latency,彻底 solves low-config machine heating and lag issues.
>
> **Engine priority recommendation**: **Cloud API** (best quality, zero local resources) → **Ollama/llama.cpp local service** (good quality, native speed, private) → **Local ONNX Large** (Qwen2.5-0.5B-Instruct, ~750MB, INT4, chunk size=5, offline but slower) → **Local ONNX Small** (Qwen2-0.5B-Instruct-ONNX, ~750MB, INT4, chunk size=3, for low-config machines) → **MT** (instant but lowest quality).

> **Troubleshooting — when subtitles don't appear**: open the Popup and click **"Test Connection"** — it sends a live request to your configured endpoint and tells you exactly what failed (unreachable, wrong model ID, bad response structure, etc.). You can also check the **"last failure"** line (always visible; shows the concrete reason, e.g. `LLM translation failed: HTTP 404`). If the reason is `no caption strategies applicable`, the caption track couldn't be fetched (not a translation failure); the cause distinguishes three sub-cases — player-response JSON not found, JSON parse failed, or the video genuinely has no caption tracks. If the reason is a timedtext parse error, the caption response format wasn't recognized — the extension requests `fmt=json3` and falls back to `srv3` XML parsing; and if the timedtext request is blocked by YouTube's `pot` token protection, the extension transparently reuses the player's own caption response instead. Common causes: the model ID doesn't match the server's actual model name (omlx returns `404 Model not found`); wrong endpoint format (both `http://127.0.0.1:8000/v1` and `http://127.0.0.1:8000/v1/chat/completions` are auto-normalized). **Note**: Chrome exempts plain-HTTP `127.0.0.1`/`localhost` from mixed-content blocking, so a local endpoint like `http://127.0.0.1:PORT/v1` works as-is — no HTTPS needed.

---

## Architecture (brief)

Hexagonal (ports & adapters): a stable `domain` core, pluggable `adapters`, an `application` orchestrator, and a `runtime` that wires everything (DI). Dependency direction is always `adapters/application → domain`.

Full design lives in [`doc/`](./doc/):

- `doc/requirements-design.md` — requirements, features (F-01…F-13), milestones.
- `doc/architecture-design.md` — ports, adapters, data structures, real-time analysis.
- `doc/system-test-design.md` — test strategy, layered test cases (TC-*).
- `doc/project-progress.md` — live progress table.

Engineering rules (including the content-script reliability red-lines) are in [`AGENTS.md`](./AGENTS.md).

---

## License

MIT — see [LICENSE](./LICENSE).
