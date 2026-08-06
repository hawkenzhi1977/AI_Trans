# AI_Trans

**Real-time translated subtitles for YouTube — a Chrome MV3 extension.**

AI_Trans grabs a video's captions (or, later, transcribes its audio), translates them with a configurable engine (cloud LLM or local model), and renders the result as an overlay on the player — without leaving the page.

繁體中文說明見 [README.zh-Hant.md](./README.zh-Hant.md).

---

## Features

### Implemented (Milestone M1)

- **Native caption translation** — detects and fetches YouTube's native caption track, translates it, and overlays it on the player.
- **Overlay subtitle rendering** — monolingual or bilingual (source + translation), rendered on a dedicated overlay layer aligned to playback time.
- **Playback-synced subtitles** — subtitles follow current time, pause, and seek via media events + `requestAnimationFrame`.
- **Configurable translation engine** — cloud LLM (OpenAI-compatible `/chat/completions`) as primary, traditional MT as fallback; endpoint, model, and API key are user-configured. API keys are stored separately from the config object.
- **Local LLM service support** — works with local OpenAI-compatible servers (mlx / omlx / LM Studio / Ollama): the endpoint field accepts either a Base URL (`http://127.0.0.1:8000/v1`) or a full `/chat/completions` path (auto-normalized); `http://127.0.0.1/*` and `http://localhost/*` host permissions are granted; reasoning-model `<think>` blocks are stripped from the reply; long reasoning requests time out (30s) and degrade to the MT fallback; config changes hot-reload across contexts via `chrome.storage.onChanged`.
- **Target language & subtitle style** — pick target language, display mode (mono/bilingual), font size, color, and background.
- **Options & Popup UI** — full settings page plus a quick popup (status + reload).
- **Reliability-hardened content script** — host-method binding (no "Illegal invocation"), leak-free subscriptions on config hot-reload, tolerant external JSON parsing (see `AGENTS.md` §5).
- **Translation-failure diagnostics** — degrade/error events are no longer silently swallowed by the pipeline: the failure reason is persisted to `chrome.storage.local` and **always shown** on the Popup's "last failure" line (no record → shows "none", so you can always confirm it's working), plus a `console.warn` breadcrumb. When **no caption strategy can take over** (e.g. the video's native caption track can't be fetched — different from a translation failure), that's also reported with the underlying reason, so "no captions found" and "translation failed" are distinguishable. A **"Test Connection" button** in the Popup sends a minimal live request to the configured endpoint — verifying reachability, model name, and response structure in one click. The Popup's translation status line also shows the **actual model name in effect** (local mode), making it easy to confirm whether a save actually updated storage.

### Planned (later milestones)

- **M2 — Real-time ASR** (`F-06`, `F-07`): capture tab audio and run streaming ASR + translation for videos without captions. Local Whisper (WASM/WebGPU) and cloud ASR, both configurable.
- **M3 — Look-ahead pre-buffering** (`F-08`): for captionless-but-prefetchable videos, transcribe buffered audio ahead of playback (higher risk / optimization).
- **Additional platforms** beyond YouTube.

> Only M1 (native-caption path) is production-ready today. The three-tier subtitle strategy (native → pre-buffer ASR → real-time ASR) is fully designed; see `doc/`.

---

## Option 1 — Use the prebuilt release (no build needed)

Prebuilt artifacts live in [`release/`](./release/):

- `release/ai-trans-extension/` — unpacked extension folder (recommended).
- `release/ai-trans-extension-v0.1.0.zip` — zipped archive.

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

- **Translation engine**: cloud LLM / local / MT, model, endpoint, API key, fallback.
- **ASR engine** (for future M2): local Whisper / cloud, model tier, endpoint.
- **Target language**, **display mode** (mono/bilingual), **performance profile**.
- **Subtitle style**: font size, color, background.

API keys are written to a separate secure storage slot and are never embedded into the plain config object.

### Using a local LLM (mlx / omlx / LM Studio / Ollama)

1. Set **Translation engine** to `local` and enter the model ID your server exposes.
2. For **endpoint**, either the Base URL (`http://127.0.0.1:8000/v1`) or the full path (`http://127.0.0.1:8000/v1/chat/completions`) works — it is auto-normalized.
3. Enter the API key if your server requires one (any non-empty string otherwise).
4. Save. The content script hot-reloads the config; if a YouTube tab is already open, the change applies without a manual reload.

> **Reasoning models**: models that emit long `<think>` reasoning are supported (the `<think>` block is stripped), but a single translation can take 30–40s and may hit the 30s request timeout, degrading to the MT fallback. For live subtitles prefer a non-reasoning (instruct) model.

> **Troubleshooting — when subtitles don't appear**: open the Popup and click **"Test Connection"** — it sends a live request to your configured endpoint and tells you exactly what failed (unreachable, wrong model ID, bad response structure, etc.). You can also check the **"last failure"** line (always visible; shows the concrete reason, e.g. `LLM translation failed: HTTP 404`) or look for `[AI_Trans] translation degraded` in the DevTools console. If the reason is `no caption strategies applicable`, the caption track couldn't be fetched (not a translation failure); the cause distinguishes three sub-cases — player-response JSON not found, JSON parse failed, or the video genuinely has no caption tracks. Common causes: the model ID doesn't match the server's actual model name (omlx returns `404 Model not found`); wrong endpoint format (both `http://127.0.0.1:8000/v1` and `http://127.0.0.1:8000/v1/chat/completions` are auto-normalized). **Note**: Chrome exempts plain-HTTP `127.0.0.1`/`localhost` from mixed-content blocking, so a local endpoint like `http://127.0.0.1:PORT/v1` works as-is — no HTTPS needed.

---

## Architecture (brief)

Hexagonal (ports & adapters): a stable `domain` core, pluggable `adapters`, an `application` orchestrator, and a `runtime` that wires everything (DI). Dependency direction is always `adapters/application → domain`.

Full design lives in [`doc/`](./doc/):

- `doc/requirements-design.md` — requirements, features (F-01…F-09), milestones.
- `doc/architecture-design.md` — ports, adapters, data structures, real-time analysis.
- `doc/system-test-design.md` — test strategy, layered test cases (TC-*).
- `doc/project-progress.md` — live progress table.

Engineering rules (including the content-script reliability red-lines) are in [`AGENTS.md`](./AGENTS.md).

---

## License

MIT — see [LICENSE](./LICENSE).
