# MeetResult Setup & Complete Guide

This document covers installation, configuration, and usage reference for MeetResult. For an overview of what the app does, see [README.md](README.md).

> **Language note:** this documentation is in English. The app itself (menu bar, Settings window, log messages) and the meeting minutes it generates are in Indonesian; where this guide mentions a menu or button, the Indonesian label is shown in **bold** with an English gloss the first time.

## Table of Contents

- [Quick Install (macOS app)](#quick-install-macos-app)
- [1. Prerequisites](#1-prerequisites)
- [2. Installation from Source](#2-installation-from-source)
- [3. Configuration](#3-configuration)
- [4. AI Provider Setup for Minutes](#4-ai-provider-setup-for-minutes)
- [5. Transcription Providers and Accuracy](#5-transcription-providers-and-accuracy)
- [6. Calendar Setup](#6-calendar-setup)
- [7. Active Meeting Detection](#7-active-meeting-detection)
- [8. Usage](#8-usage)
- [9. Menu Bar App (macOS)](#9-menu-bar-app-macos)
- [10. Updating the App](#10-updating-the-app)
- [11. Data Layout](#11-data-layout)
- [12. MoM Templates](#12-mom-templates)
- [13. Performance for Long Meetings](#13-performance-for-long-meetings-2-hours)
- [14. Important Notes](#14-important-notes)

## Quick Install (macOS app)

The easiest way to run MeetResult is the installer package — no Node.js, npm, or terminal needed.

1. Download **`MeetResult-<version>.pkg`** from the [latest release](https://github.com/aansun/MeetResult/releases/latest).
2. Double-click it and follow the installer. It places a self-contained **MeetResult.app** in `/Applications` (it bundles its own Node.js runtime).
3. Open **MeetResult** from Launchpad. A menu-bar icon appears and the **Settings** window opens on the first launch — fill in your calendar link and pick your AI provider(s).
4. If **ffmpeg** or the **BlackHole** audio driver is missing, the app says so and offers to install them for you through Homebrew (Terminal opens and runs `brew install ...`). These two are system components that cannot be bundled.
5. Optional: menu bar → **Buka saat Login** (*Open at Login*) so the app starts with your Mac. When your calendar is configured, the app starts watching it automatically on every launch.

**Good to know**

- **Gatekeeper:** the installer and app are signed *ad hoc* (no Apple Developer ID), so macOS asks for a one-time approval. Right-click the `.pkg` → **Open**; for the app on first launch, right-click → **Open**, or use **System Settings → Privacy & Security → Open Anyway**.
- **Requirements:** Apple Silicon (arm64) and macOS 13 or later.
- **Where things live:** your settings (`.env`) and all data (audio, transcripts, minutes, database) are in `~/Library/Application Support/MeetResult` — deliberately outside iCloud-synced folders such as `~/Documents`, which can cause intermittent file-permission errors. The app itself is read-only inside `/Applications`.
- **Local Whisper is optional.** Cloud transcription providers (Gemini, OpenAI, 9Router…) need nothing extra. For offline transcription install `whisper-ctranslate2` as described in [Prerequisites](#1-prerequisites).
- **Updating:** menu bar → **Cek Update...** (*Check for Updates*) opens the download page when a newer installer exists. Run the new `.pkg`; your data and settings are untouched.
- **Uninstalling:** delete `/Applications/MeetResult.app`; also delete `~/Library/Application Support/MeetResult` if you want to remove your data.
- **Building the installer yourself:** `./scripts/build-installer.sh` produces `dist/MeetResult-<version>.pkg` (downloads the official Node.js runtime once and verifies its SHA-256 checksum).
- **Terminal commands:** the installed app does not add a `meetresult` command to your shell. Everything is available from the menu bar; to run CLI commands use the bundled runtime, e.g. `MEETRESULT_HOME=~/Library/Application\ Support/MeetResult /Applications/MeetResult.app/Contents/Resources/node/bin/node /Applications/MeetResult.app/Contents/Resources/app/bin/meetresult.js list`.

The rest of this guide describes running from a source checkout; all settings and behaviors below apply to the installed app too.

## 1. Prerequisites

- Node.js >= 18
- ffmpeg (`brew install ffmpeg`)
- Python + [whisper-ctranslate2](https://github.com/Softcatala/whisper-ctranslate2) for local transcription (lightweight and fast, no PyTorch, well suited to Apple Silicon):
  ```bash
  python3 -m pip install --user --upgrade pip
  python3 -m pip install --user -U whisper-ctranslate2
  whisper-ctranslate2 --help   # verify the install
  ```
  Default model: **`large-v3`** — the most accurate, especially for names and specialised terms (see the real comparison in [13. Performance](#13-performance-for-long-meetings-2-hours)), but about 4x slower than `medium` and about 2x larger (first download ~2.9 GB vs ~1.4 GB). Use `medium` if speed matters more (for example very long or routine meetings), or `small` for the fastest option at lower accuracy.
- **macOS**: to record **system audio** (the Teams voices, not just your mic), install a virtual audio device:
  ```bash
  brew install blackhole-2ch
  ```
  Then create a **Multi-Output Device** / **Aggregate Device** in `Audio MIDI Setup` that combines your speakers with BlackHole, and set it as the audio output during meetings so you can still hear while it records.

## 2. Installation from Source

### Install Node dependencies

```bash
cd MeetResult
npm install
```

### Register the `meetresult` command globally (REQUIRED)

So you can run `meetresult ...` from any terminal (instead of `node bin/meetresult.js ...`):

```bash
npm link
meetresult --version   # make sure it works, no "command not found" error
```

> If after a Mac restart or a new terminal you see `zsh: command not found: meetresult`, it is usually because `npm link` was never run on that computer — run it once per computer.

## 3. Configuration

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|---|---|
| `AZURE_CLIENT_ID` | Azure AD App Registration client ID (see [Calendar Setup](#6-calendar-setup)) |
| `AZURE_TENANT_ID` | `common` (default) or your organization's tenant ID |
| `SUMMARY_PROVIDER` | AI provider for the minutes: `claude` (default), `openai`, `agy`, `opencode`, or `ninerouter` (see [AI Provider Setup](#4-ai-provider-setup-for-minutes)) |
| `SUMMARY_FALLBACK_PROVIDER` | Backup provider used when the main one fails (empty = disabled) |
| `CLAUDE_MODE` | `cli` (default, uses the logged-in Claude Code, NO API key) or `api` (Anthropic API, pay per token) |
| `CLAUDE_CLI_BIN` | Name/path of the Claude Code CLI binary (default `claude`) |
| `ANTHROPIC_API_KEY` | Only used when `CLAUDE_MODE=api`. From https://console.anthropic.com/settings/keys |
| `ANTHROPIC_MODEL` | Only used when `CLAUDE_MODE=api`. Default `claude-3-5-sonnet-latest` |
| `OPENAI_BASE_URL` | Only used when `SUMMARY_PROVIDER=openai`. Defaults to OpenAI cloud, or point it at a local server (oMLX/Ollama/LM Studio) |
| `OPENAI_API_KEY` | Only used when `SUMMARY_PROVIDER=openai`. Leave empty for local servers that need no auth |
| `OPENAI_MODEL` | Only used when `SUMMARY_PROVIDER=openai`. Model name for your provider/server |
| `AGY_CLI_BIN` / `AGY_MODEL` | Only used when `SUMMARY_PROVIDER=agy`. See [AI Provider Setup](#4-ai-provider-setup-for-minutes) |
| `TRANSCRIBE_PROVIDER` | `whisper` (default, local/offline), `gemini`, `openai`, `openai-compatible`, or `ninerouter` (see [Transcription Providers](#5-transcription-providers-and-accuracy)) |
| `TRANSCRIBE_FALLBACK_PROVIDER` | Backup transcription provider (recommended: `whisper` when the main one is cloud) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Only used when `TRANSCRIBE_PROVIDER=gemini`. Key from https://aistudio.google.com/apikey |
| `WHISPER_MODEL` | `small` / `medium` / `large` (bigger = more accurate, slower) |
| `WHISPER_BATCHED` | `true` (default) — speeds up transcription 2-4x, important for long meetings |
| `WHISPER_BATCH_SIZE` | Default `8`. Lower to `4` on limited RAM (≤8 GB) |
| `WHISPER_VAD_FILTER` | `true` (default) — skips silence, faster and more accurate |
| `WHISPER_LANGUAGE` | `id` for Bahasa Indonesia |
| `FFMPEG_AUDIO_DEVICE_INDEX` | Index/name of the audio input device (see `meetresult devices`) |
| `AUDIO_RETENTION_DAYS` | Days to keep audio files before automatic deletion (default `3`) |
| `PREVENT_SLEEP_WHILE_RECORDING` | `true` (default) — keeps the Mac awake while recording |
| `MOM_PREPARED_BY` | Name shown in the "Disusun oleh" (*Prepared by*) field of the MoM document |
| `MOM_ORG_NAME` | Optional programme/organization name shown as the document subtitle |
| `MOM_POLISH_LANGUAGE` | `true` (default) — polishes the minutes' wording (more professional/concise) with one extra AI call, without changing structure or dropping information |

Every option above can also be set in the **Pengaturan** (*Settings*) window of the menu bar app (see [section 9](#9-menu-bar-app-macos)) without editing `.env` by hand.

## 4. AI Provider Setup for Minutes

The transcription step (audio → text) is configured separately — see [section 5](#5-transcription-providers-and-accuracy). This section covers the **minutes** step (transcript text → MoM JSON), selected with `SUMMARY_PROVIDER` in `.env`:

| `SUMMARY_PROVIDER` | Best for |
|---|---|
| `claude` (default) | Claude Code CLI (subscription, no API key) or the Anthropic API |
| `openai` | An **OpenAI-compatible** Chat Completions endpoint — **cloud** (OpenAI) or **local** (oMLX, Ollama, LM Studio, vLLM, …) |
| `agy` | **Antigravity CLI** (Google, Gemini models), already logged in on this Mac — subscription, no separate API key |
| `opencode` | **OpenCode CLI** (many models through OpenCode Zen/Go), already logged in — minutes only, not transcription |
| `ninerouter` | The **9Router** gateway ([github.com/decolua/9router](https://github.com/decolua/9router), local/remote, OpenAI-compatible) — one key, many providers, automatic fallback |

> **Auto-detection on install**: `npm install` checks whether a local AI server is running — **oMLX** (reads the port and API key straight from `~/.omlx/settings.json`, so authentication is included), **Ollama** (`:11434`), or **LM Studio** (`:1234`). If one is found, `.env` is set to `SUMMARY_PROVIDER=openai` with the matching `OPENAI_BASE_URL` (plus `OPENAI_API_KEY` for oMLX). If you start a local server after installing, re-run detection any time:
> ```bash
> meetresult setup-ai
> ```
> Anything you already set manually is not overwritten unless you use `meetresult setup-ai --force`.

After filling in the configuration, verify that **every configured model** really works (no files or recordings are created):
```bash
meetresult test-ai
```
(or the **Test** button in Settings — see [Testing all models and provider resilience](#testing-all-models-and-provider-resilience)).

### Option A — `openai` with a LOCAL server (private, free, offline)

1. Start the OpenAI-compatible server of your choice, for example:
   - **oMLX** (Apple Silicon, https://omlx.app): start the app; the server comes up per `~/.omlx/settings.json` (default port `8000`, needs an API key — see step 2)
   - **Ollama**: `ollama serve`, then `ollama pull llama3.1` (default port `11434`, no API key)
   - **LM Studio**: enable "Local Server" in the app (default port `1234`, no API key)
2. Run `meetresult setup-ai` (or reinstall) so `.env` is filled automatically (for oMLX the API key is picked up too), or fill it in manually:
   ```
   SUMMARY_PROVIDER=openai
   OPENAI_BASE_URL=http://localhost:11434/v1
   OPENAI_MODEL=llama3.1
   ```

### Option B — `openai` with the cloud (OpenAI or another OpenAI-compatible provider)

```
SUMMARY_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

### Option C — `claude` (CLI mode — default, recommended)

MeetResult can use the **Claude Code CLI** logged in with your subscription (Pro/Max/Team), so you **do not pay for a separate API**.

1. Make sure the Claude Code CLI is installed and on your PATH as `claude`:
   ```bash
   claude --version
   ```
   If it is not on your PATH but you have the Claude Desktop app, the binary is usually at:
   ```
   ~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude
   ```
   Create a symlink so it is easy to call:
   ```bash
   ln -sf "$HOME/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude" /opt/homebrew/bin/claude
   ```
   (The watcher also repairs a broken or missing `claude` symlink automatically after Claude Desktop updates.)
2. Log in (interactive, once):
   ```bash
   claude setup-token   # recommended: long-lived token for background automation
   # or
   claude auth login
   ```
3. Check the status:
   ```bash
   claude auth status
   ```
4. In `.env`, make sure:
   ```
   CLAUDE_MODE=cli
   CLAUDE_CLI_BIN=claude
   ```

> **Keep only one `claude` installation on your PATH.** A standalone install (for example `~/.local/bin/claude`) and the one bundled with Claude Desktop share the same Keychain credentials and can invalidate each other's login, which shows up as a repeating `OAuth session expired` error. MeetResult warns you when it finds two, and the model test shows which binary is used. Always log in with that exact binary (`<path> auth login`).

> Alternative: set `CLAUDE_MODE=api` and fill in `ANTHROPIC_API_KEY` to use the Anthropic API directly (billed per token, does not use your Claude Code subscription).

### Option D — `agy` (Antigravity CLI, Gemini models)

[Antigravity](https://antigravity.google) is Google's official CLI for Gemini models (the same pattern as the Claude Code CLI above) — MeetResult shells out to the `agy` binary that you installed and logged in yourself; it does **not** reverse-engineer OAuth or spoof anything.

1. Install and log in to the Antigravity CLI following its official guide, and make sure `agy` is on your PATH:
   ```bash
   agy --version
   ```
2. Check that you are logged in and see the available models:
   ```bash
   agy models
   ```
3. In `.env`:
   ```
   SUMMARY_PROVIDER=agy
   AGY_CLI_BIN=agy
   AGY_MODEL=gemini-3.8-flash-high
   ```
   Leave `AGY_MODEL` empty to use the default model of the logged-in session. Model names change over time — if `agy` reports `invalid model selection`, run `agy models` and update `AGY_MODEL`.

> Technical note: `agy` receives the prompt as a **command argument**, not via stdin (unlike the Claude CLI) — MeetResult handles this automatically. If the Google login expires, `agy` asks for an interactive login; MeetResult detects that within about a second, reports it as a warning in the menu bar, and does not wait on it.

### Option E — `opencode` (OpenCode CLI, many models — MINUTES ONLY)

[OpenCode](https://opencode.ai) is a coding-agent CLI that can reach many models (Claude, GPT, Gemini, …) through the OpenCode Zen/Go services — MeetResult shells out to the `opencode` binary that you installed and logged in yourself.

1. Install and log in to the OpenCode CLI following its official guide, and make sure `opencode` is on your PATH:
   ```bash
   opencode --version
   opencode providers login
   ```
2. List the available models:
   ```bash
   opencode models
   ```
3. In `.env`:
   ```
   SUMMARY_PROVIDER=opencode
   OPENCODE_CLI_BIN=opencode
   OPENCODE_MODEL=opencode/gemini-3.7-flash
   ```
   `OPENCODE_MODEL` MUST use the `provider/model` format (for example `opencode/gemini-3.7-flash` or `opencode-go/kimi-k3`). Leave it empty to use OpenCode's default.

> **IMPORTANT — why OpenCode is NOT used for audio transcription**: OpenCode is a coding agent with shell access, not a plain text/audio API. Tested directly: attaching an audio file (`-f audio.wav`) fails with "Cannot read binary file", and after failing the model tries to run shell commands on the machine (for example `which whisper`, `ffprobe`) to find another way to finish the task. That is fine for ordinary text prompts (minutes) but NOT safe for an unattended pipeline that processes audio — so OpenCode is offered only as a **minutes** provider and does not appear in the transcription provider list.

### Option F — `ninerouter` (9Router, multi-provider gateway)

[9Router](https://github.com/decolua/9router) is a local/remote OpenAI-compatible gateway that gathers many AI providers (OpenAI, Anthropic, Gemini, Groq, …) behind **one URL and one API key**, with automatic fallback between accounts. MeetResult calls it through the official `/v1/chat/completions` endpoint.

1. Start/prepare your 9Router instance (local or remote/tunnel) and note its URL (for example `http://localhost:20128`) and the API key from Dashboard → Keys (if the instance enables `requireApiKey`).
2. List the available chat models:
   ```bash
   curl $NINEROUTER_URL/v1/models | jq '.data[].id'
   ```
3. In `.env`, or through the **Pengaturan** (*Settings*) window:
   ```
   SUMMARY_PROVIDER=ninerouter
   NINEROUTER_URL=http://localhost:20128
   NINEROUTER_API_KEY=...
   NINEROUTER_MODEL=openai/gpt-5
   ```
   `NINEROUTER_MODEL` MUST use the `provider/model` format (the exact `id` from `/v1/models`). In the Settings window, the ↻ button next to the Model field fetches this list for you.

> **Note — "Invalid model format"**: if you get this error, `NINEROUTER_MODEL` does not exactly match one of the `id` values from `GET <NINEROUTER_URL>/v1/models` — re-check with the ↻ button or the curl command above instead of guessing the format.

### Backup (Fallback) Provider for Minutes

When the main provider fails (technical error, exhausted quota, an empty or invalid response, …), MeetResult can automatically retry through a backup provider so the minutes still get written. Configure it in the **Pengaturan** window ("Provider Fallback") or in `.env`:

```
SUMMARY_PROVIDER=agy
SUMMARY_FALLBACK_PROVIDER=claude
```

Leave `SUMMARY_FALLBACK_PROVIDER` empty to disable it (default). If both the primary AND the fallback fail, both errors are combined in the final message so the cause is clear.

The Mode/Model fields of a provider (Claude, OpenAI, Antigravity) in the Settings window appear automatically whenever that provider is used in **either role** — as primary or as fallback. For example, with `SUMMARY_PROVIDER=agy` and `SUMMARY_FALLBACK_PROVIDER=claude`, the Claude Mode/Model fields stay visible and editable even though Claude is not the primary, so you can make sure the model used during a fallback is really configured rather than an empty default.

### Testing all models and provider resilience

The **Test** button in Settings (or `meetresult test-ai`) tests **every** model you filled in, one at a time and **without letting a fallback rescue it**: minutes (primary and fallback) with a small transcript, and transcription (primary and fallback) with **real spoken audio** (an Indonesian voice generated by macOS `say`) containing marker names. The result is a ✅/⚠️/❌ list per model, with the actual error text and the fix. The test can take a few minutes (Whisper loads its local model).

When minutes are generated, the watcher handles provider failures like this:
- An **empty or non-JSON response** counts as a failure -> the fallback is tried right away (it used to slip through and blow up later as "Gagal parse JSON").
- **Transient problems** (network, 503, empty) are retried once after 30 seconds (`AI_TRANSIENT_RETRIES`, `AI_TRANSIENT_RETRY_DELAY_MS`).
- An **expired login** (agy/claude) is not retried: it fails immediately with the login command and a warning in the menu bar. `agy` asking for an interactive Google login no longer hangs for 60 seconds.
- **Two different `claude` installations on PATH** (for example `~/.local/bin` and the Claude Desktop one) share Keychain credentials and can invalidate each other's login — the watcher warns once, and the test result shows which binary is used.
- A `db.json` or template that is briefly inaccessible (EPERM/EBUSY — common in iCloud-managed folders or under macOS folder-permission checks) is retried several times; the database is never silently replaced by an empty one if it cannot be read.

## 5. Transcription Providers and Accuracy

The transcription provider (`TRANSCRIBE_PROVIDER`) can be chosen in the **Pengaturan** window or directly in `.env`. There are 5 choices — the first three were verified with a real test on the same audio (a podcast dense with Arabic/Islamic terms, see the table below):

| Provider | `TRANSCRIBE_PROVIDER` | Where it runs | Needs internet | Accuracy on specialised terms (real test result) |
|---|---|---|---|---|
| **Whisper** (default) | `whisper` | Local (your machine) | No | Good for general sentences; the `large-v3` model (default) fixes some specialised-term mistakes compared with `medium`, but not all |
| **Gemini** | `gemini` | Cloud (Google) | Yes | **Best** — 100% correct on every test term (names, Arabic terms) |
| **OpenAI** | `openai` | Cloud (official OpenAI) | Yes | Better than Whisper `medium`, but still some mistakes on very specific terms |
| **Custom (OpenAI-compatible)** | `openai-compatible` | Your own server (local/custom) | Depends on the server | Not verified — depends on the model on that server |
| **9Router** | `ninerouter` | Local/remote gateway (many providers) | Yes | Depends on the STT provider installed on that instance |

**When to use the cloud (Gemini/OpenAI)**: when you do not want to install Whisper locally, your machine is slow or short on RAM, or you need maximum accuracy for content with specialised terms or names (foreign, Arabic, etc.). **Trade-off**: it needs an internet connection and the meeting audio is sent to a third-party server (Google/OpenAI) — unlike Whisper, which is 100% local.

**When to use Custom (OpenAI-compatible)**: when you run your own transcription server (local/self-hosted) that exposes an OpenAI Audio Transcriptions-shaped endpoint (`POST /audio/transcriptions`) — for example one you deployed yourself, not OpenAI. This provider is **deliberately separate** from `openai` (official OpenAI cloud) so the two configurations (Base URL/API Key/Model) never get mixed up — both can even be active at the same time in different roles (for example `openai` as primary and `openai-compatible` as fallback, or the reverse).

### Gemini setup (optional)

1. Get an API key at https://aistudio.google.com/apikey
2. Check the latest **audio-capable** model name in Google AI Studio (Gemini model names change over time, so MeetResult deliberately ships no default). In the Settings window, the ↻ button next to Model lists the models available to your key.
3. Fill it in through the **Pengaturan** (*Settings*) window, or directly in `.env`:
   ```
   TRANSCRIBE_PROVIDER=gemini
   GEMINI_API_KEY=...
   GEMINI_MODEL=...
   ```
4. Gemini enforces a per-minute request limit (some tiers allow only 15 requests/minute). When a request fails, MeetResult retries up to 3 times with a 60-second pause between attempts (never in a tight loop), and only then falls back to your fallback provider. Tune it with `GEMINI_TRANSCRIBE_MAX_RETRIES` and `GEMINI_TRANSCRIBE_RETRY_DELAY_MS`.

### OpenAI setup (optional)

This provider sends audio to the **official OpenAI cloud**.

1. Get an API key at https://platform.openai.com/api-keys
2. Fill it in through the **Pengaturan** window, or directly in `.env`:
   ```
   TRANSCRIBE_PROVIDER=openai
   OPENAI_TRANSCRIBE_API_KEY=...
   OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
   ```
   > `OPENAI_TRANSCRIBE_API_KEY`/`OPENAI_TRANSCRIBE_BASE_URL` are deliberately separate from `OPENAI_API_KEY`/`OPENAI_BASE_URL`, which are used for minutes (`SUMMARY_PROVIDER=openai`) — the minutes base URL often points at a LOCAL server (oMLX/Ollama/LM Studio) that has no audio endpoint, whereas the transcription base URL defaults to the real OpenAI cloud and rarely needs changing.

After filling it in, run `meetresult transcribe <file.wav>` to test it, or use the **Test** button in Settings.

> Model guidance from a real test on the same Indonesian meeting clip: `gpt-4o-transcribe` was the most reliable (it got both technical terms right), `whisper-1` was close but garbled one acronym, and `gpt-4o-mini-transcribe` was the weakest (it misheard a person's name). Gemini `gemini-3.6-flash` got all four key terms right in that test.

> The transcription provider is separate from the minutes provider (`SUMMARY_PROVIDER`) — you can mix them, for example Gemini for transcription and Claude for minutes, or the reverse.

### Custom OpenAI-compatible setup (optional)

For a transcription server that **you run yourself** (local/self-hosted, not OpenAI) and that exposes an OpenAI Audio Transcriptions-shaped endpoint (`POST /audio/transcriptions`). It is a **deliberately separate provider** from `openai` above — so the Base URL/API Key/Model of the two never get mixed up, and you can use both at once (for example one as primary and one as fallback).

1. Fill it in through the **Pengaturan** window, or directly in `.env`:
   ```
   TRANSCRIBE_PROVIDER=openai-compatible
   OPENAI_COMPATIBLE_TRANSCRIBE_BASE_URL=http://localhost:8000/v1
   OPENAI_COMPATIBLE_TRANSCRIBE_API_KEY=
   OPENAI_COMPATIBLE_TRANSCRIBE_MODEL=
   ```
   `OPENAI_COMPATIBLE_TRANSCRIBE_BASE_URL` is **required** and has no default — no assumption is made about which server you mean. `OPENAI_COMPATIBLE_TRANSCRIBE_API_KEY` may stay empty if the server needs no authentication, and `OPENAI_COMPATIBLE_TRANSCRIBE_MODEL` may stay empty if the server has a single model and ignores the parameter.

In the **Pengaturan** window, the ↻ button next to the Model field fetches the model list straight from `<Base URL>/models` of the endpoint you entered (the CLI equivalent is `meetresult models --scope transcribe`) — handy to confirm that a custom endpoint is really up and to see the model IDs it offers.

After filling it in, run `meetresult transcribe <file.wav>` to test it, or use the **Test** button in Settings.

### 9Router setup for transcription (optional)

[9Router](https://github.com/decolua/9router) also has a speech-to-text endpoint (`POST /v1/audio/transcriptions`), served by whichever Whisper/Groq/Gemini/Deepgram/AssemblyAI/NVIDIA/HuggingFace provider accounts you have installed on your instance. It is a **deliberately separate provider** from the `ninerouter` minutes provider (see [Option F](#option-f--ninerouter-9router-multi-provider-gateway) above) — the URL/API key/model of the two roles never get mixed up, even though both use 9Router.

1. List the **speech-to-text** models (DIFFERENT from the chat model list at `/v1/models` above):
   ```bash
   curl $NINEROUTER_URL/v1/models/stt | jq '.data[].id'
   ```
   > If this list is EMPTY, your 9Router instance has no STT provider account installed at all — add one first in the 9Router dashboard (for example an OpenAI/Groq account for Whisper). Whatever model you send will be rejected while this list is empty.
2. In `.env`, or through the **Pengaturan** window:
   ```
   TRANSCRIBE_PROVIDER=ninerouter
   NINEROUTER_TRANSCRIBE_URL=http://localhost:20128
   NINEROUTER_TRANSCRIBE_API_KEY=...
   NINEROUTER_TRANSCRIBE_MODEL=openai/whisper-1
   ```
   `NINEROUTER_TRANSCRIBE_MODEL` MUST use the `provider/model` format, the exact id from `/v1/models/stt` (NOT from the ordinary `/v1/models`). In the Settings window, the ↻ button next to Model fetches this list for you.

After filling it in, run `meetresult transcribe <file.wav>` to test it, or use the **Test** button in Settings.

### Helping Whisper recognise names and specialised terms (if you stay local)

Whisper is accurate on general sentences, but it **often gets personal names and foreign/Arabic terms wrong** when they are rare in its training data (for example scholars' names or book titles) — sometimes replacing them with a word that sounds similar but means something very different. If your content has many such terms, set in `.env`:

```
WHISPER_HOTWORDS=Taqiyuddin an-Nabhani, Al-Khaliq, khilafah, kaffah, Rib'i bin Amir
```

This helps **significantly** (verified: 4 of 7 problem terms were corrected right away in a real test), but it **does not guarantee 100%** — terms that sound very much like another common word (for example the name of God "Al-Khaliq" versus the word "alkoholik") are sometimes still wrong even with a hint. For maximum accuracy on content like this, `TRANSCRIBE_PROVIDER=gemini` above proved the most consistently correct.

### Whisper model not downloaded yet?

The `WHISPER_MODEL` model (for example `large-v3`) is downloaded **automatically** from Hugging Face the first time it is used for transcription — no manual step is needed. To download it ahead of time (so the first recording does not wait on a download), the **Pengaturan** window shows the model status (downloaded or not) with a **Unduh** (*Download*) button, or use the terminal:

```bash
meetresult whisper-status --model large-v3   # check the status
meetresult whisper-download --model large-v3 # download now
```

### Backup (Fallback) Provider for Transcription

If the main transcription provider fails (technical error, exhausted API quota, lost internet, …), MeetResult can automatically retry through a backup provider so the transcript still gets produced. Configure it in the **Pengaturan** window ("Fallback Transkripsi") or in `.env`:

```
TRANSCRIBE_PROVIDER=gemini
TRANSCRIBE_FALLBACK_PROVIDER=whisper
```

**Recommendation**: when the main provider is cloud (Gemini/OpenAI), use `whisper` as the fallback — local Whisper never runs out of quota or connection, so transcription almost certainly succeeds even when the cloud is having problems. Leave `TRANSCRIBE_FALLBACK_PROVIDER` empty to disable it (default).

**A dedicated Whisper model for the fallback**: if the fallback is `whisper`, you can use a model DIFFERENT from the regular `WHISPER_MODEL` through `WHISPER_FALLBACK_MODEL` (or the "Model Whisper (Fallback)" field in the Settings window) — useful when you want the most accurate main model (for example `large-v3`) but a faster emergency fallback (for example `medium`), so a cloud outage does not also mean a long wait. Leave it empty to use the same model as `WHISPER_MODEL`.

```
WHISPER_MODEL=large-v3
WHISPER_FALLBACK_MODEL=medium
```

## 6. Calendar Setup

MeetResult supports two ways to read your Outlook calendar. Set it with `CALENDAR_MODE` in `.env`.

### Mode A — `ics` (default, EASIEST, no Azure app)

No Azure application or OAuth login is needed. You only have to "publish" your calendar:

1. Open **Outlook Web** (outlook.office.com or outlook.com)
2. Click **Settings ⚙️** → **Calendar** → **Shared calendars**
3. Pick your calendar → **Publish a calendar**
4. Permission: choose **"Can view all details"** (not "Can view when I'm busy", so meeting titles and locations are readable)
5. Click **Publish**, then copy the link in **ICS** format (not HTML)
6. Paste it into `.env`:
   ```
   CALENDAR_MODE=ics
   CALENDAR_ICS_URL=https://outlook.office365.com/owa/calendar/xxxxxxxx/calendar.ics
   ```
7. Done — **no** `meetresult login` is needed; you can go straight to `meetresult agenda` / `meetresult watch`

> Note: Outlook usually refreshes this ICS feed every ~15–30 minutes (not real time), the Teams join link is taken from the event's description/location, and **organizer/attendee data is not available** in the published feed (restricted by Microsoft for privacy) — if you need that data in full, use Mode B (`graph`).

### Mode B — `graph` (real time, needs an Azure App Registration)

Use it if you need more real-time schedule detection or more complete data.

1. Open https://portal.azure.com → **Azure Active Directory** → **App registrations** → **New registration**
2. Name: `MeetResult`, Supported account types: as needed (Single/Multi tenant)
3. No Redirect URI is needed (the app uses the **Device Code Flow**), but if asked, add the platform **Mobile and desktop applications** with the URI `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Under **Authentication**, enable **Allow public client flows** = Yes
5. Under **API permissions**, add Microsoft Graph (Delegated): `Calendars.Read`, `User.Read`, `OnlineMeetings.Read`
6. Copy the **Application (client) ID** into `AZURE_CLIENT_ID`, and set `CALENDAR_MODE=graph`
7. For work accounts (Office 365 organizations), the `Calendars.Read` permission usually does not need admin consent, but it depends on each company's IT policy
8. Run `meetresult login` before using `agenda`/`watch`

## 7. Active Meeting Detection

Auto-record is triggered purely by the **calendar schedule** (start–end time), NOT by the actual Teams call state. If a calendar event still exists but the meeting was actually cancelled, rescheduled, or never happened, then without protection the mic keeps recording whatever happens nearby during that scheduled window — including private conversations outside any meeting.

Two layers of protection are on by default:

1. **Check that Teams is running before starting** (`REQUIRE_TEAMS_RUNNING=true`, default) — if the Microsoft Teams application is not open at all when the schedule starts, auto-record is cancelled (the meeting is marked `skipped`).
2. **Re-check audio activity after a few minutes** (`SILENCE_CHECK_AFTER_MINUTES=5`, default) — if at minute 5 Teams is NOT running **and** the system audio channel (BlackHole, the other participants' voices) has been completely silent since recording began, the recording is stopped automatically and **not processed** (transcript and minutes are skipped, saving AI cost and keeping private conversations out of the summary). Any audio and transcript already captured are kept (following normal retention) for manual reference in case it was a false positive.

Both signals (Teams not running **and** audio silent) must hold before a recording is stopped — so a genuine meeting that is merely quiet at the start (waiting for participants to join, etc.) is not discarded by mistake. Set either one to `false`/`0` in `.env` to disable it.

> This protection does **not** apply to manual recording (`meetresult record`) — that is always your explicit decision.

### Overrunning and back-to-back meetings

The mic and BlackHole can record **only one meeting at a time**. When a meeting reaches its start time while another recording is still running, the watcher decides as follows:

| Situation | What happens |
|---|---|
| Meeting A is **past its scheduled end** (overran) and meeting B has started | **Hand-off**: A's recording is cut right then, A is processed (transcript + minutes) in the background, and B starts recording immediately. Reasoning: A is already past its slot while B has started, so you have almost certainly moved on to B. A ⚠️ warning tells you the recording was split there. |
| The schedules **genuinely overlap** (A is not due to end yet) | A's recording is **left alone** (there is no way to know which meeting you are attending). B stays `scheduled` and starts automatically as soon as A stops, as long as B has not ended. A ⚠️ warning appears **once** to say B is not being recorded. To record B now, stop the running recording first. |

Previously the first case meant B was never recorded and its audio ended up merged into A's recording (one transcript containing two meetings).

### The Mac is kept awake while recording

While ffmpeg is recording, MeetResult keeps the Mac from sleeping (`caffeinate`, macOS only) — released automatically when the recording ends, even if the watcher crashes. This prevents recordings being cut off by idle sleep (a real incident: audio was lost because the Mac slept mid-meeting). It **cannot** prevent sleep caused by **closing the laptop lid** — macOS forces that — so keep the lid open (or use an external display plus power). Disable it with `PREVENT_SLEEP_WHILE_RECORDING=false`.

### Warning when calendar fetches keep failing

The watcher polls your Outlook calendar every `WATCH_INTERVAL_MINUTES` (default 2 minutes). If a fetch fails (for example the laptop slept or lost Wi-Fi for hours unnoticed), this used to be logged silently in `data/watcher.log` and only discovered after a meeting was missed.

Now, when calendar fetches fail **3 times in a row**, a macOS notification appears once, plus a warning line in the menu bar app (Watch submenu): "⚠️ Kalender gagal fetch Nx - cek internet" (*calendar fetch failed Nx — check internet*). The notification fires once per incident (no spam every 2 minutes) and the line disappears as soon as a fetch succeeds again.

## 8. Usage

### Log in to Outlook

```bash
meetresult login
```
Follow the device-code instructions that appear (open the browser, enter the code). Only needed for `CALENDAR_MODE=graph`.

### Check audio devices (once at the start, to set up `.env`)

```bash
meetresult devices
```

### Re-detect a local AI server for minutes (oMLX/Ollama/LM Studio)

```bash
meetresult setup-ai
```

### List models and verify AI providers

```bash
meetresult models      # models available for the active provider
meetresult test-ai     # test every configured model (minutes + transcription, primary + fallback)
```

### View the Teams meeting agenda

```bash
meetresult agenda --minutes 1440   # the next day
```

### Automatic mode (recommended) — run in the background / a separate terminal

```bash
meetresult watch
```
The app watches the calendar every few minutes, starts recording automatically when a Teams meeting begins, and automatically stops, transcribes, and writes the minutes when the meeting ends.

**If a meeting overruns its calendar slot** (for example scheduled for 30 minutes but the discussion continues), the recording is **not cut at the scheduled time** — the watcher first checks whether Microsoft Teams is still running. If it is, the recording is extended automatically and re-checked every `MEETING_OVERTIME_CHECK_INTERVAL_MINUTES` (default 3 minutes) until Teams is closed, with `MAX_MEETING_OVERTIME_MINUTES` (default 120 minutes) past the scheduled end as a safety net.

### Manual recording

```bash
meetresult record --name "Weekly Team Sync"
# ... after the meeting ends ...
meetresult stop
```

### Process an existing audio file manually

```bash
meetresult process recording.wav --title "Q4 Budget Meeting"
```

### Transcribe and summarize separately

```bash
meetresult transcribe data/recordings/xxxx.wav
meetresult summarize data/transcripts/xxxx.txt --title "Q4 Budget Meeting"
meetresult summarize data/transcripts/xxxx.txt --title "..." --model <id>   # override the model for one run
```

### Retry a failed meeting

```bash
meetresult retry <meetingId>              # redo from the furthest step still possible (transcript exists -> only the minutes)
meetresult retry <meetingId> --transcribe # force a fresh transcription from the audio
```

### View the list and results of the minutes

```bash
meetresult list
meetresult show <meetingId>          # show the summary in the terminal
meetresult show <meetingId> --open   # also open the .docx file in Word
```

### Clean up old audio files manually (optional)

```bash
meetresult cleanup
```
By default this also runs automatically every day at 03:00 while `meetresult watch` is active.

## 9. Menu Bar App (macOS)

A native menu bar indicator (icon **"MR"**) lets you see MeetResult's status at a glance without opening a terminal. (The installed app starts it automatically; from a source checkout use:)

```bash
meetresult tray
```

- 🟢 Green = Watch active on standby, 🔴 Red = recording automatically, 🟡 Yellow = recording manually, ⚪ Grey = everything stopped. A ⚠️ next to "MR" means there are unread warnings (or the code/config changed since the watcher started).

**Watch menu (automatic mode via the calendar):**
- **Start** / **Stop** — control the watcher (equivalent to `meetresult watch`)
- **Restart Watch** — restart the watcher manually at any time (for example after editing `.env` by hand outside Settings)
- A ⚠️ badge appears automatically when the code or configuration changed since the watcher last started, with an option to restart straight away

**Manual Recording menu (meetings outside the calendar, e.g. an impromptu or unscheduled call):**
- **Start** — a dialog asks for the meeting name, then recording starts
- **Stop** — stop the manual recording; transcript and MoM generation then continue in the background

**Event List** — today's meetings with their status; click a finished one to open its minutes

**Gagal Diproses (N)** (*Failed to process*) — appears automatically when a meeting (last 30 days) failed, or is stuck in "processing" for more than 3 hours, **and still has audio or a transcript** on disk. For each meeting you can choose:
- **Buat ulang notulen (pakai transkrip yang ada)** (*Rebuild minutes from the existing transcript*) — no re-transcription (saves time and quota); right when only the minutes step failed (for example an AI provider error or exhausted quota)
- **Transkrip ulang dari audio + notulen** (*Re-transcribe from audio + minutes*) — when the transcript does not exist yet or came out poor (needs audio that has not been removed by the 3-day retention)

It runs in the background and a notification appears when it finishes or fails. From a terminal: `meetresult retry <meetingId>` (add `--transcribe` to force re-transcription).

**Peringatan (N)** (*Warnings*) — appears when something went wrong: a provider failed (even if the fallback rescued the job), a recording could not be finalized, or processing failed. A macOS notification is shown once per warning with the actual error text, and the menu lists the latest ones (click one for the full message; **Tandai Semua Sudah Dibaca** marks them all read). ⚠️ means a problem that was handled; ⛔ means it failed and needs your action (for example a provider whose login expired — the warning includes the exact command to log in again).

**Pengaturan...** (*Settings*) — a native window (not hand-editing `.env`), with a navigation menu on the left and the settings detail on the right (the macOS System Settings pattern). It has 3 sections:
- **Notulen** (*Minutes*) — MoM template, Prepared by, Organization name (applies to all template schemes)
- **Transkripsi** (*Transcription*) — two separate groups divided by a line: **Provider** and **Fallback Provider**
- **Notulen AI** (*Minutes AI*) — the same, two separate groups: **Provider** and **Fallback Provider**

In the Transcription and Minutes AI sections, each group holds its own provider dropdown **together with all the settings that belong to that provider** (Type / API Key / Model), so there is never any doubt which API Key belongs to which provider. The fields shown follow the provider chosen in that group:

| Provider | Fields shown |
|---|---|
| Whisper (local) | Model (+ model status/download) — no API Key because it runs locally |
| Gemini | API Key, Model (↻ lists your key's models) |
| OpenAI (transcription) | API Key, Model |
| OpenAI-compatible (transcription) | Base URL, API Key, Model (↻ lists the endpoint's models) |
| 9Router (transcription) | URL, API Key, Model (↻ lists the speech-to-text models) |
| Claude | Type (cli/api), Model (↻ refreshes the model list) — plus API Key when Type = `api` |
| OpenAI (minutes) | Base URL, API Key, Model |
| 9Router (minutes) | URL, API Key, Model |
| Antigravity / OpenCode | Model |

Combine freely: a cloud provider can be the fallback of a local one or the reverse, and each one's settings are always available in its own group. For Whisper specifically, the Model for the primary and fallback roles is separate (`WHISPER_MODEL` vs `WHISPER_FALLBACK_MODEL`) so you can use a different model in each role.

The **Test** button verifies **every model you filled in** (see [Testing all models](#testing-all-models-and-provider-resilience)) before you save.

**Other items:**
- **Buka Notulen** (*Open Minutes*) — opens the `data/summaries` folder in Finder
- **Log Aktivitas** (*Activity Log*) — opens `data/watcher.log`
- **Cek Update...** (*Check for Updates*) — checks the latest version on the GitHub repo (see [Updating the App](#10-updating-the-app))
- **Buka saat Login** (*Open at Login*) — installed app only; starts MeetResult when you log in
- **Keluar** (*Quit*) — closes the menu bar app (a running watcher/recording is not stopped automatically; stop it first if needed)

The icon is built natively with Swift/AppKit (`mac/MeetResultTray.swift`), with no heavy Electron dependency. If you change the source, recompile with:
```bash
bash mac/build.sh
```

> From a source checkout, to have the menu bar app start every time the Mac boots, add `meetresult tray` to **System Settings → General → Login Items**. (The installed app has its own **Buka saat Login** menu item.)

## 10. Updating the App

Repo: **https://github.com/aansun/MeetResult**

- **Installed app:** menu bar → **Cek Update...**. If a newer version exists, the app opens the download page; run the new `MeetResult-<version>.pkg`. Your data and settings (in `~/Library/Application Support/MeetResult`) are kept. Restart the watcher afterwards (the app offers to when it detects changed code).
- **Source checkout:**

```bash
meetresult update              # check whether a newer version exists
meetresult update --apply      # check + apply right away (git pull && npm install)
```

How update detection works:
- If the project is a `git clone`, MeetResult compares the local HEAD commit with `origin` (needs internet, no login).
- If it is not a git clone (for example a manual download/extract, or the installed app), it falls back to reading the version from `package.json` on GitHub directly. The installed app cannot update itself in place, so it sends you to the new installer instead.

Manual update (if you do not use `--apply`):
```bash
git pull
npm install
```

> After a code update, restart the watcher (the menu bar app automatically offers "Restart Watch" once it detects the code changed) so the latest fixes and features take effect.

## 11. Data Layout

```
<home>/                  # source checkout: the project folder; installed app: ~/Library/Application Support/MeetResult
  .env                   # your settings
  data/
    recordings/          # .wav audio from recordings (automatically deleted after AUDIO_RETENTION_DAYS days)
    transcripts/
      2026-08/           # transcription results (.txt), grouped automatically by month
    summaries/
      2026-08/           # meeting minutes (.docx), grouped automatically by month
        json/            # the raw JSON data behind each document (used by `meetresult show`)
    db.json              # metadata of every meeting
    alerts.json          # warnings shown in the menu bar app
    watcher.log          # activity log
  Template/              # optional: your own MoM templates and logo (override the built-in ones)
```

> The monthly folders (`YYYY-MM`) in `transcripts/` and `summaries/` are created automatically from the meeting date — so they do not pile up into one big folder over time. The summaries folder contains only `.docx` files (the documents you share); the raw JSON lives in its `json/` subfolder.

## 12. MoM Templates

The generated `.docx` uses a **dynamic template** (`Template/mom_template.docx`) containing tags/placeholders, rendered automatically with the data from the AI summary. Its structure:

- **Header**: Subject, Day/Date, Media, Participants, Prepared by
- **A. Pembahasan dan Kesepakatan** (*Discussion and Agreements*): table with No, Topic, Status/Discussion, Agreement
- **B. Action Items**: table with No, Action Item, PIC, Target
- Footer note

The file name is automatic: `{MeetingTitle}_{YYYYMMDD}.docx` (a duplicate automatically gets a `(2)`, `(3)`, … suffix).

### The two available MoM schemes

| `MOM_TEMPLATE_TYPE` | Best for | Structure |
|---|---|---|
| `structured` (default) | Weekly project progress/review meetings | Discussion & Agreement table + Action Items table |
| `meeting_minutes` | Formal/audit/policy-review meetings | Numbered narrative Resume + Attendances table (Name/Company/Position) |

Change it in `.env`:
```
MOM_TEMPLATE_TYPE=meeting_minutes
```
Each scheme's default template is used automatically (`Template/mom_template.docx` or `Template/mom_meeting_minutes_template.docx`) unless you override it with `MOM_TEMPLATE_PATH`. A template with the same file name in `<home>/Template/` takes priority over the built-in one.

In the `meeting_minutes` template, the Resume uses **real Word numbered lists**: main points are numbered 1., 2., 3. (bold) and their sub-points are lettered a., b., c., restarting under every main point, each sub-point being its own paragraph with a hanging indent so long lines wrap neatly. The template tags for this are `{#resume}` … `{point}` … `{#subpoints}` `{text}` `{/subpoints}` … `{/resume}`. Older/custom templates that still use `{no}. {point}` with `{subpointsText}` keep working.

**Logo:** put `logo.jpeg`, `logo.jpg`, or `logo.png` in the `Template/` folder (or point `MOM_LOGO_PATH` at it) and add the text `{%logo}` where you want it in a template. The logo is read locally at generation time and is never committed to git; if the file is missing or unreadable, the document is still produced without it.

### Using a NEW TEMPLATE (no code changes)

If you have a new MoM design with the SAME structure/fields as one of the schemes above (say a different logo, colours, or company letterhead but the same fields), here is how:

**1. Prepare a `.docx` file** (not PDF) with these exact tags (upper/lower case must match):

| Tag | Filled with |
|---|---|
| `{subject}` | Meeting title |
| `{dateLabel}` | Day/Date (Indonesian format, automatic) |
| `{media}` | Meeting medium (for example Online Meeting - Microsoft Teams) |
| `{participants}` | Participant list |
| `{preparedBy}` | Author's name (from `MOM_PREPARED_BY`) |
| `{notes}` | Extra notes/footer |

**2. For repeating tables** (Discussion & Action Items), make one table row as a "mould" that is repeated automatically for every item:

- Discussion table: put `{#discussion}` in the **first cell** of the data row (combined with `{no}`), then `{topic}`, `{status}`, and `{/discussion}` in the **last cell** (combined with `{agreement}`).
  ```
  Cell 1: {#discussion}{no}   Cell 2: {topic}   Cell 3: {status}   Cell 4: {agreement}{/discussion}
  ```
- Action Items table: the same pattern with `{#actionItems}` … `{/actionItems}`, fields: `{no}`, `{item}`, `{pic}`, `{target}`.

  See a real example in `Template/mom_template.docx` (open it in Word to see exactly where the tags sit) or `scripts/generate-default-template.js` for the source.

**3. Save the new template** into the `Template/` folder, for example `Template/mom_template_new.docx`.

**4. Point the app at the new template** — edit `.env`:
   ```
   MOM_TEMPLATE_PATH=Template/mom_template_new.docx
   ```

**5. Done!** Run `meetresult process`/`watch` as usual — it uses your new template automatically, WITHOUT restarting any code or changing the program.

> ⚠️ **Important for repeating table/paragraph loops (docxtemplater)**: for PARAGRAPH loops (such as the Resume), the opening tag `{#name}` and closing tag `{/name}` must each sit in a **separate/empty paragraph**, apart from the content paragraphs — otherwise the 2nd and later items stick to the previous item. For TABLE (row) loops, put the opening tag in the first cell and the closing tag in the last cell of the same row — that is already correct with no separate paragraph needed. See `scripts/generate-meeting-minutes-template.js` as the reference example.

### When a field/column is truly NEW (a 3rd scheme, etc.)

If your new template needs a field that exists in neither scheme (for example "Document Number" or "Approval"), share the design (send a sample PDF/Word file) so it can be built:
1. A new `Template/mom_<name>_template.docx` file with the matching tags
2. A new scheme in `src/summarize/schemas/<name>Schema.js` (the AI system prompt + data mapping)
3. Registration in `src/summarize/summarizer.js` so it can be selected with `MOM_TEMPLATE_TYPE=<name>`

This is needed only once per new design — after it is registered it can be reused any number of times through `.env` alone.

## 13. Performance for Long Meetings (2+ hours)

Audio is **not split manually** — Whisper's internal architecture already processes long audio in sequential ~30-second windows, so one whole audio file (of any duration) is sent to Whisper as is. To speed things up and save resources on long meetings, two built-in `whisper-ctranslate2` optimisations are enabled by default:

- **`WHISPER_BATCHED=true`** — processes several audio segments in parallel within one model (2-4x faster)
- **`WHISPER_VAD_FILTER=true`** — skips silent parts (faster, and lowers the risk of hallucinated text in silent sections)

**Real benchmark results** (MacBook Apple M5, `medium` model, 14 minutes 40 seconds of audio):

| Metric | Result |
|---|---|
| Transcription time | 1 minute 50 seconds (**~8x faster than real time**) |
| Estimate for a 2-hour meeting | **~15 minutes** |
| Peak RAM | ~5.7 GB (of 16 GB, about 35%, only briefly) |
| CPU | Multi-core (does not load a single core only) |

**Comparison with `large-v3`** (the current default model, MacBook Apple M5, different audio of 12 minutes 3 seconds, the same `WHISPER_BATCHED`/`WHISPER_VAD_FILTER` settings):

| Metric | `medium` | `large-v3` |
|---|---|---|
| Transcription time | ~1x proportional speed | **~4.2x slower** than `medium` |
| Speed vs real time | ~6.6x faster | **~1.6x faster** (still faster than the audio duration, but a much thinner margin) |
| Estimate for a 2-hour meeting | ~18 minutes | **~1 hour 17 minutes** |
| Model size (first download) | ~1.4 GB | **~2.9 GB** |

`large-v3` was verified to fix certain Islamic/Arabic term mistakes compared with `medium` (for example "Al-Khaliq" is no longer heard as "alkoholik"), but it does **not** guarantee every foreign name/term is heard correctly — for content dense in specific terms like that, combine it with `WHISPER_HOTWORDS`/`WHISPER_INITIAL_PROMPT` (see section 5), or consider `TRANSCRIBE_PROVIDER=gemini`, which proved far more accurate for this case.

If your meetings are very long or routine and processing time matters more than maximum accuracy, lower `WHISPER_MODEL` to `medium` (faster, still good accuracy for general conversation) or `small` (fastest). If RAM is limited (≤8 GB), lower `WHISPER_BATCH_SIZE` to `4`.

## 14. Important Notes

- Recording **system audio** (the other participants' voices in Teams) requires a virtual audio device (BlackHole on macOS, Stereo Mix/VB-Cable on Windows, a PulseAudio monitor on Linux) — this is a platform limitation, not an app limitation.
- Make sure you comply with company policy and local law regarding **recording consent** for meetings.
- The Whisper `medium`/`large` models are more accurate for Bahasa Indonesia but need more resources.
- **Claude cannot be used for audio transcription** (Anthropic models currently accept only text and images, not audio) — with `SUMMARY_PROVIDER=claude`, transcription still uses Whisper/Gemini, and only the resulting text is sent to Claude to write the minutes.
- **Self-healing Claude CLI symlink (macOS)**: when Claude Desktop auto-updates to a new version, the `claude` symlink on your PATH (for example `/opt/homebrew/bin/claude`) sometimes breaks or disappears (it points at an old version folder that was removed, and Claude Desktop's folder layout also changed over time). When the Claude CLI is in use (`cli` mode, as the primary OR the fallback minutes provider), the watcher automatically checks and repairs this symlink on every polling cycle — **no restart is needed**, and the fix applies to the very next `claude` call. It only touches symlinks that point into Claude Desktop's folder and never overwrites another installation.
- **File-permission errors (`EPERM`) in iCloud-synced folders**: if your project or data folder lives under `~/Documents` or `~/Desktop` with iCloud "Desktop & Documents" sync enabled, macOS can briefly refuse access to files or create "conflict copy" files such as `watcher 2.pid`. MeetResult retries such errors, but the robust fix is to keep the data outside iCloud — which is exactly where the installed app keeps it (`~/Library/Application Support/MeetResult`). From a source checkout, move the project folder out of `~/Documents` or set `MEETRESULT_HOME` to a folder outside iCloud.
- **Data folder override**: the installed app's data folder can be redirected with the `MEETRESULT_HOME` environment variable (used by the app to separate its read-only code from your data).
