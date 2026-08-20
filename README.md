# MeetResult

CLI untuk **merekam, mentranskrip, dan membuat notulen/ringkasan rapat Microsoft Teams secara otomatis**, terintegrasi dengan **Outlook Calendar**. Mendukung penuh **Bahasa Indonesia**.

Tujuannya sederhana: kamu ikut rapat seperti biasa, MeetResult yang urus sisanya — rekam, transkrip, dan susun notulen rapi dalam format Word (.docx) sesuai template perusahaan, tanpa perlu ketik ulang manual setelah rapat selesai.

## ✨ Fitur

- 🔗 **Integrasi Outlook Calendar** (ICS atau Microsoft Graph) — deteksi otomatis jadwal meeting Teams
- ⏺️ **Auto-record** — mulai/berhenti rekam otomatis sesuai jadwal, dengan deteksi meeting aktif supaya tidak salah rekam percakapan di luar meeting
- ⌨️ **Rekam manual** — kapan saja, di luar jadwal kalender
- 📝 **Transkripsi otomatis** — Whisper (lokal/offline) atau Gemini API
- 🤖 **Notulen/MoM otomatis** — pilih provider AI: Claude, OpenAI-compatible (cloud maupun lokal), atau Antigravity/Gemini
- 📄 Output **file Microsoft Word (.docx)** mengikuti template perusahaan, 2 skema siap pakai (progress meeting atau meeting minutes formal)
- 💻 **Menu bar app** (macOS) — kontrol & pengaturan tanpa buka terminal
- 🗑️ **Retensi otomatis** & organisasi folder per bulan, supaya data tidak menumpuk
- 💾 Semua hasil (audio, transkrip, notulen) tersimpan lokal

## 🧩 Arsitektur Pipeline

```
Outlook Calendar (ICS / Graph API)
        │  deteksi meeting Teams terjadwal
        ▼
   Watcher (cron)
        │  saat waktu mulai tiba (+ deteksi meeting benar-benar aktif)
        ▼
   Recorder (ffmpeg) ──► file .wav
        │  saat meeting selesai
        ▼
   Transcriber (Whisper / Gemini, bahasa=id) ──► file .txt
        │
        ▼
   Summarizer (Claude / OpenAI-compatible / Antigravity) ──► notulen .docx
        │
        ▼
   Retention Job ──► hapus audio > N hari (harian, jam 03:00)
```

## 📚 Instalasi & Konfigurasi

Detail prasyarat, instalasi, setup provider AI, kalender, template MoM, dan referensi command lengkap ada di **[SETUP.md](SETUP.md)**.

## 🔄 Update Aplikasi

```bash
meetresult update --apply
```

Repo: **https://github.com/aansun/MeetResult**
