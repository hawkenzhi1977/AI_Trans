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
- **Target language & subtitle style** — pick target language, display mode (mono/bilingual), font size, color, and background.
- **Options & Popup UI** — full settings page plus a quick popup (status + reload).
- **Reliability-hardened content script** — host-method binding (no "Illegal invocation"), leak-free subscriptions on config hot-reload, tolerant external JSON parsing (see `AGENTS.md` §5).

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
