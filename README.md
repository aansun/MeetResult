# MeetResult

A tool that **automatically records, transcribes, and writes meeting minutes for Microsoft Teams meetings**, integrated with **Outlook Calendar**. Full **Bahasa Indonesia** support (transcripts and minutes are produced in Indonesian).

The idea is simple: you attend meetings as usual, and MeetResult does the rest — it records, transcribes, and drafts clean minutes as a Word (.docx) document following your company template, so nobody has to retype notes after the meeting.

## ✨ Features

- 🔗 **Outlook Calendar integration** (ICS or Microsoft Graph) — automatically detects scheduled Teams meetings
- ⏺️ **Auto-record** — starts/stops recording on schedule, with active-meeting detection so conversations outside a meeting are not recorded by mistake
- 🔁 **Overrun and back-to-back handling** — a meeting that runs past its slot is not cut off while Teams is still running; when the next meeting starts, the recording is split cleanly
- ⌨️ **Manual recording** — any time, outside the calendar schedule
- 📝 **Automatic transcription** — Whisper (local/offline), Gemini, OpenAI, OpenAI-compatible servers, or 9Router, with a fallback provider
- 🤖 **Automatic minutes** — pick an AI provider: Claude, OpenAI-compatible (cloud or local), Antigravity/Gemini, OpenCode, or 9Router, with a fallback provider
- 📄 **Microsoft Word (.docx) output** following your company template, with two ready-made schemes (progress meeting or formal meeting minutes) and real Word numbered lists
- 💻 **Menu bar app** (macOS) — control and settings without opening a terminal; warnings with the actual error text, a "Failed" menu to retry a meeting, and a one-click test of every configured model
- 🛡️ **Resilient by design** — retries transient failures, falls back between providers, keeps the Mac awake while recording, and never loses the meeting history if the database is briefly unreadable
- 🗑️ **Automatic retention** and per-month folders, so data does not pile up
- 💾 Everything (audio, transcripts, minutes) is stored locally

## 📦 Install (one click)

Download **`MeetResult-<version>.pkg`** from the [latest release](https://github.com/aansun/MeetResult/releases/latest) and double-click it. The installer puts a self-contained **MeetResult.app** in `/Applications` (it bundles its own Node.js runtime — nothing else to install first). Open it from Launchpad: a menu-bar icon appears, the Settings window opens on first launch, and the app offers to install the two system components it cannot bundle (**ffmpeg** and the **BlackHole** audio driver) through Homebrew.

> The installer is signed ad hoc, not with an Apple Developer ID, so macOS asks for a one-time approval: right-click the `.pkg` → **Open**, and the same for the app on first launch (or **System Settings → Privacy & Security → Open Anyway**).

Your settings and data live in `~/Library/Application Support/MeetResult` (outside iCloud-synced folders). To uninstall, delete `/Applications/MeetResult.app`, and that folder if you also want to remove your data. Requires Apple Silicon and macOS 13 or later.

Prefer building from source? See **[SETUP.md](SETUP.md)**; `./scripts/build-installer.sh` rebuilds the installer.

## 🧩 Pipeline Architecture

```
Outlook Calendar (ICS / Graph API)
        │  detect scheduled Teams meetings
        ▼
   Watcher (cron)
        │  when the start time arrives (+ check the meeting is really active)
        ▼
   Recorder (ffmpeg) ──► .wav file
        │  when the meeting ends
        ▼
   Transcriber (Whisper / Gemini / OpenAI / 9Router, language=id) ──► .txt file
        │
        ▼
   Summarizer (Claude / OpenAI-compatible / Antigravity / OpenCode / 9Router) ──► minutes .docx
        │
        ▼
   Retention Job ──► delete audio older than N days (daily, 03:00)
```

## 📚 Installation & Configuration

Prerequisites, installation, AI provider setup, calendar setup, MoM templates, and the full command reference are in **[SETUP.md](SETUP.md)**.

## 🔄 Updating

- **Installed app:** menu bar → **Check for Updates…** opens the download page when a newer installer exists; run the new `.pkg` — your data and settings are kept.
- **Source checkout:**

```bash
meetresult update --apply
```

Repo: **https://github.com/aansun/MeetResult**
