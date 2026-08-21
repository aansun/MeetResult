# Setup & Panduan Lengkap MeetResult

Dokumen ini berisi detail instalasi, konfigurasi, dan referensi pemakaian MeetResult. Untuk gambaran umum & tujuan aplikasi, lihat [README.md](README.md).

## Daftar Isi

- [1. Prasyarat](#1-prasyarat)
- [2. Instalasi](#2-instalasi)
- [3. Konfigurasi](#3-konfigurasi)
- [4. Setup Provider AI untuk Notulen](#4-setup-provider-ai-untuk-notulen)
- [5. Transkripsi via Gemini (opsional)](#5-transkripsi-via-gemini-opsional)
- [6. Setup Kalender](#6-setup-kalender)
- [7. Deteksi Meeting Aktif](#7-deteksi-meeting-aktif)
- [8. Cara Pakai](#8-cara-pakai)
- [9. Menu Bar App (macOS)](#9-menu-bar-app-macos)
- [10. Update Aplikasi](#10-update-aplikasi)
- [11. Struktur Data](#11-struktur-data)
- [12. Template MoM](#12-template-mom)
- [13. Performa untuk Meeting Panjang](#13-performa-untuk-meeting-panjang-2-jam)
- [14. Catatan Penting](#14-catatan-penting)

## 1. Prasyarat

- Node.js >= 18
- ffmpeg (`brew install ffmpeg`)
- Python + [whisper-ctranslate2](https://github.com/Softcatala/whisper-ctranslate2) untuk transkripsi (ringan & cepat, tanpa PyTorch, cocok untuk Apple Silicon):
  ```bash
  python3 -m pip install --user --upgrade pip
  python3 -m pip install --user -U whisper-ctranslate2
  whisper-ctranslate2 --help   # cek berhasil terinstall
  ```
  Model default: **`large-v3`** — paling akurat, terutama untuk nama/istilah khusus (lihat perbandingan nyata di bagian [13. Performa](#13-performa-untuk-meeting-panjang-2-jam)), tapi ~4x lebih lambat dari `medium` dan modelnya ~2x lebih besar (unduhan pertama kali ~2.9GB vs ~1.4GB). Gunakan `medium` kalau lebih mengutamakan kecepatan (mis. meeting sangat panjang/rutin), atau `small` untuk paling cepat dengan akurasi lebih rendah.
- **macOS**: agar bisa merekam **audio sistem** (suara Teams, bukan cuma mic), install virtual audio device:
  ```bash
  brew install blackhole-2ch
  ```
  Lalu buat **Multi-Output Device** / **Aggregate Device** di `Audio MIDI Setup` yang menggabungkan speaker + BlackHole, dan set BlackHole sebagai output audio saat meeting agar tetap terdengar sekaligus terekam.

## 2. Instalasi

### Install dependency Node

```bash
cd MeetResult
npm install
```

### Daftarkan command `meetresult` secara global (WAJIB)

Supaya bisa jalankan `meetresult ...` dari terminal mana pun (bukan `node bin/meetresult.js ...`):

```bash
npm link
meetresult --version   # pastikan berhasil, tidak error "command not found"
```

> Kalau habis restart Mac / buka terminal baru muncul `zsh: command not found: meetresult`, biasanya karena langkah `npm link` ini belum pernah dijalankan di komputer tersebut — cukup jalankan sekali saja per komputer.

## 3. Konfigurasi

```bash
cp .env.example .env
```

Isi `.env`:

| Variabel | Keterangan |
|---|---|
| `AZURE_CLIENT_ID` | Client ID App Registration Azure AD (lihat [Setup Kalender](#6-setup-kalender)) |
| `AZURE_TENANT_ID` | `common` (default) atau tenant ID organisasi kamu |
| `SUMMARY_PROVIDER` | Provider AI untuk notulen: `claude` (default), `openai`, atau `agy` (lihat [Setup Provider AI](#4-setup-provider-ai-untuk-notulen)) |
| `CLAUDE_MODE` | `cli` (default, pakai Claude Code yang sudah login, TANPA API key) atau `api` (pakai Anthropic API, berbayar per token) |
| `CLAUDE_CLI_BIN` | Nama/path binary Claude Code CLI (default `claude`) |
| `ANTHROPIC_API_KEY` | Hanya dipakai jika `CLAUDE_MODE=api`. Dari https://console.anthropic.com/settings/keys |
| `ANTHROPIC_MODEL` | Hanya dipakai jika `CLAUDE_MODE=api`. Default `claude-3-5-sonnet-latest` |
| `OPENAI_BASE_URL` | Hanya dipakai jika `SUMMARY_PROVIDER=openai`. Default OpenAI cloud, atau arahkan ke server lokal (oMLX/Ollama/LM Studio) |
| `OPENAI_API_KEY` | Hanya dipakai jika `SUMMARY_PROVIDER=openai`. Kosongkan untuk server lokal yang tidak butuh auth |
| `OPENAI_MODEL` | Hanya dipakai jika `SUMMARY_PROVIDER=openai`. Nama model sesuai provider/server |
| `AGY_CLI_BIN` / `AGY_MODEL` | Hanya dipakai jika `SUMMARY_PROVIDER=agy`. Lihat [Setup Provider AI](#4-setup-provider-ai-untuk-notulen) |
| `TRANSCRIBE_PROVIDER` | `whisper` (default, lokal/offline) atau `gemini` (butuh internet, lihat [Transkripsi via Gemini](#5-transkripsi-via-gemini-opsional)) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Hanya dipakai jika `TRANSCRIBE_PROVIDER=gemini`. Dari https://aistudio.google.com/apikey |
| `WHISPER_MODEL` | `small` / `medium` / `large` (makin besar makin akurat, makin lambat) |
| `WHISPER_BATCHED` | `true` (default) - percepat transkripsi 2-4x, penting untuk meeting panjang |
| `WHISPER_BATCH_SIZE` | Default `8`. Kecilkan ke `4` kalau RAM terbatas (≤8GB) |
| `WHISPER_VAD_FILTER` | `true` (default) - skip bagian hening/silence, lebih cepat & akurat |
| `WHISPER_LANGUAGE` | `id` untuk Bahasa Indonesia |
| `FFMPEG_AUDIO_DEVICE_INDEX` | Index/nama device audio input (lihat `meetresult devices`) |
| `AUDIO_RETENTION_DAYS` | Berapa hari file audio disimpan sebelum dihapus otomatis (default `3`) |
| `MOM_PREPARED_BY` | Nama yang tercantum di kolom "Disusun oleh" pada dokumen MoM |
| `MOM_ORG_NAME` | Nama program/organisasi opsional yang tampil sebagai subjudul dokumen |
| `MOM_POLISH_LANGUAGE` | `true` (default) - haluskan bahasa notulen (lebih profesional/padat) lewat 1x panggilan AI tambahan, tanpa mengubah struktur/menghilangkan info |

Semua opsi di atas juga bisa diatur lewat window **Pengaturan** di menu bar app (lihat [bagian 9](#9-menu-bar-app-macos)), tanpa perlu edit `.env` manual.

## 4. Setup Provider AI untuk Notulen

Step transkripsi (audio→teks) diatur terpisah — lihat [bagian 5](#5-transkripsi-via-gemini-opsional). Yang dijelaskan di sini adalah step **notulen** (teks transkrip → JSON MoM), lewat `SUMMARY_PROVIDER` di `.env`:

| `SUMMARY_PROVIDER` | Cocok untuk |
|---|---|
| `claude` (default) | Pakai Claude Code CLI (subscription, tanpa API key) atau Anthropic API |
| `openai` | Pakai endpoint Chat Completions **OpenAI-compatible** — bisa **cloud** (OpenAI) atau **lokal** (oMLX, Ollama, LM Studio, vLLM, dll) |
| `agy` | Pakai **Antigravity CLI** (Google, akses model Gemini) yang sudah login di mesin — subscription, tanpa API key terpisah |

> **Auto-deteksi saat install**: `npm install` otomatis mengecek apakah ada server AI lokal aktif — **oMLX** (baca port & API key langsung dari `~/.omlx/settings.json`, jadi otomatis TERMASUK autentikasinya), **Ollama** (`:11434`), atau **LM Studio** (`:1234`). Kalau ketemu, `.env` langsung di-set `SUMMARY_PROVIDER=openai` + `OPENAI_BASE_URL` (+ `OPENAI_API_KEY` untuk oMLX) yang sesuai. Kalau server lokal baru dinyalakan setelah install, jalankan ulang deteksinya kapan saja:
> ```bash
> meetresult setup-ai
> ```
> Konfigurasi yang sudah pernah di-set manual tidak akan ditimpa kecuali pakai `meetresult setup-ai --force`.

Setelah konfigurasi diisi, verifikasi provider/model benar-benar bisa dipakai (tanpa bikin file/rekaman) dengan:
```bash
meetresult test-ai
```

### Opsi A — `openai` dengan server LOKAL (privasi, gratis, offline)

1. Jalankan server OpenAI-compatible pilihanmu, misalnya:
   - **oMLX** (Apple Silicon, https://omlx.app): jalankan app-nya, server otomatis aktif sesuai `~/.omlx/settings.json` (default port `8000`, butuh API key - lihat langkah 2)
   - **Ollama**: `ollama serve` lalu `ollama pull llama3.1` (default port `11434`, tanpa API key)
   - **LM Studio**: nyalakan "Local Server" dari app-nya (default port `1234`, tanpa API key)
2. Jalankan `meetresult setup-ai` (atau install ulang) agar `.env` otomatis terisi (untuk oMLX, API key ikut otomatis terbaca), atau isi manual:
   ```
   SUMMARY_PROVIDER=openai
   OPENAI_BASE_URL=http://localhost:11434/v1
   OPENAI_MODEL=llama3.1
   ```

### Opsi B — `openai` dengan cloud (OpenAI atau provider OpenAI-compatible lain)

```
SUMMARY_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

### Opsi C — `claude` (mode CLI — default, direkomendasikan)

MeetResult bisa memakai **Claude Code CLI** yang sudah login dengan subscription kamu (Pro/Max/Team), sehingga **tidak perlu bayar API terpisah**.

1. Pastikan Claude Code CLI terinstall & ada di PATH sebagai `claude`:
   ```bash
   claude --version
   ```
   Jika belum ada di PATH tapi kamu punya Claude Desktop app, binary-nya biasanya ada di:
   ```
   ~/Library/Application Support/Claude/claude-code/<versi>/claude.app/Contents/MacOS/claude
   ```
   Buat symlink agar mudah dipanggil:
   ```bash
   ln -sf "$HOME/Library/Application Support/Claude/claude-code/<versi>/claude.app/Contents/MacOS/claude" /opt/homebrew/bin/claude
   ```
2. Login (interaktif, sekali saja):
   ```bash
   claude setup-token   # rekomendasi: token jangka panjang untuk automasi background
   # atau
   claude auth login
   ```
3. Cek status:
   ```bash
   claude auth status
   ```
4. Di `.env`, pastikan:
   ```
   CLAUDE_MODE=cli
   CLAUDE_CLI_BIN=claude
   ```

> Alternatif: set `CLAUDE_MODE=api` dan isi `ANTHROPIC_API_KEY` jika ingin pakai Anthropic API langsung (dikenakan biaya per token, tidak pakai subscription Claude Code).

### Opsi D — `agy` (Antigravity CLI, akses model Gemini)

[Antigravity](https://antigravity.google) adalah CLI resmi Google untuk akses model Gemini (mirip pola Claude Code CLI di atas) — MeetResult shell-out ke binary `agy` yang sudah kamu install & login sendiri, **bukan** reverse-engineer OAuth/spoofing.

1. Install & login Antigravity CLI sesuai panduan resminya, pastikan `agy` ada di PATH:
   ```bash
   agy --version
   ```
2. Cek kamu sudah login & lihat model yang tersedia:
   ```bash
   agy models
   ```
3. Di `.env`:
   ```
   SUMMARY_PROVIDER=agy
   AGY_CLI_BIN=agy
   AGY_MODEL=gemini-3.5-flash-low
   ```
   Kosongkan `AGY_MODEL` untuk pakai model default sesi yang sedang login.

> Catatan teknis: `agy` menerima prompt lewat **argumen command**, bukan stdin (beda dari Claude CLI) — MeetResult sudah menangani ini otomatis, cuma relevan kalau kamu ingin tahu cara kerjanya.

### Provider Backup (Fallback) untuk Notulen

Kalau provider utama gagal (error teknis, kuota habis, dll), MeetResult bisa otomatis mencoba ulang lewat provider backup, supaya notulen tetap berhasil dibuat. Atur lewat menu tray **Pengaturan** ("Provider Fallback") atau `.env`:

```
SUMMARY_PROVIDER=agy
SUMMARY_FALLBACK_PROVIDER=claude
```

Kosongkan `SUMMARY_FALLBACK_PROVIDER` untuk nonaktifkan (default). Kalau primary DAN fallback sama-sama gagal, error dari keduanya digabung di pesan errornya supaya jelas penyebabnya.

## 5. Akurasi Transkripsi: Local (Whisper) vs Cloud (Gemini/OpenAI)

Provider transkripsi (`TRANSCRIBE_PROVIDER`) bisa dipilih dari menu tray **Pengaturan** atau langsung di `.env`. Ada 3 pilihan - semua sudah diverifikasi lewat tes nyata di audio yang sama (podcast padat istilah Arab/Islami, lihat tabel di bawah):

| Provider | `TRANSCRIBE_PROVIDER` | Lokasi proses | Butuh internet | Akurasi istilah khusus (hasil tes nyata) |
|---|---|---|---|---|
| **Whisper** (default) | `whisper` | Lokal (mesin sendiri) | Tidak | Baik untuk kalimat umum; model `large-v3` (default) memperbaiki sebagian kesalahan istilah khusus dibanding `medium`, tidak semua |
| **Gemini** | `gemini` | Cloud (Google) | Ya | **Terbaik** - benar 100% untuk semua istilah uji (nama tokoh, istilah Arab) |
| **OpenAI** | `openai` | Cloud (OpenAI) | Ya | Lebih baik dari Whisper `medium`, tapi masih ada kesalahan di istilah yang sangat spesifik |

**Kapan pakai Cloud (Gemini/OpenAI)**: kalau tidak mau install Whisper secara lokal, mesin lambat/RAM terbatas, atau butuh akurasi maksimal untuk konten dengan istilah/nama khusus (asing, Arab, dsb). **Trade-off**: butuh koneksi internet, dan audio meeting terkirim ke server pihak ketiga (Google/OpenAI) - beda dari Whisper yang 100% lokal.

### Setup Gemini (opsional)

1. Dapatkan API key di https://aistudio.google.com/apikey
2. Cek nama model **audio-capable** terbaru di Google AI Studio (nama model Gemini berubah dari waktu ke waktu, jadi sengaja tidak ada default bawaan di MeetResult)
3. Isi lewat menu tray **Pengaturan**, atau langsung di `.env`:
   ```
   TRANSCRIBE_PROVIDER=gemini
   GEMINI_API_KEY=...
   GEMINI_MODEL=...
   ```

### Setup OpenAI (opsional)

1. Dapatkan API key di https://platform.openai.com/api-keys
2. Isi lewat menu tray **Pengaturan**, atau langsung di `.env`:
   ```
   TRANSCRIBE_PROVIDER=openai
   OPENAI_TRANSCRIBE_API_KEY=...
   OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
   ```
   > `OPENAI_TRANSCRIBE_API_KEY`/`OPENAI_TRANSCRIBE_BASE_URL` SENGAJA terpisah dari `OPENAI_API_KEY`/`OPENAI_BASE_URL` yang dipakai untuk notulen (`SUMMARY_PROVIDER=openai`) - base URL notulen sering diarahkan ke server LOKAL (oMLX/Ollama) yang tidak punya endpoint audio.

Setelah diisi, jalankan `meetresult transcribe <file.wav>` untuk tes, atau tombol **Test** di Pengaturan.

> Provider transkripsi ini terpisah dari provider notulen (`SUMMARY_PROVIDER`) - kamu bisa campur, misalnya transkripsi pakai Gemini tapi notulen tetap pakai Claude, atau sebaliknya.

### Bantu Whisper mengenali istilah/nama khusus (kalau tetap pakai lokal)

Whisper cukup akurat untuk kalimat umum, tapi **sering salah untuk nama tokoh dan istilah asing/Arab** yang jarang muncul di data latihnya (mis. nama ulama, judul kitab) - kadang sampai mengganti dengan kata yang bunyinya mirip tapi maknanya jauh berbeda. Kalau konten kamu banyak istilah spesifik seperti ini, isi `.env`:

```
WHISPER_HOTWORDS=Taqiyuddin an-Nabhani, Al-Khaliq, khilafah, kaffah, Rib'i bin Amir
```

Ini membantu **signifikan** (terverifikasi: 4 dari 7 istilah bermasalah langsung terkoreksi di sebuah tes nyata), tapi **tidak menjamin 100% benar** - istilah yang bunyinya sangat mirip kata umum lain (mis. nama Allah "Al-Khaliq" vs kata "alkoholik") kadang tetap salah walau sudah dikasih hint. Untuk akurasi maksimal di konten seperti ini, `TRANSCRIBE_PROVIDER=gemini` di atas terbukti paling konsisten benar.

### Model Whisper belum terunduh?

Model `WHISPER_MODEL` (mis. `large-v3`) diunduh **otomatis** dari Hugging Face saat pertama kali dipakai untuk transkripsi - tidak perlu langkah manual. Kalau ingin mengunduh lebih dulu (supaya rekaman pertama tidak menunggu unduhan), menu tray **Pengaturan** menampilkan status model (sudah/belum terunduh) dengan tombol **Unduh** untuk memicu unduhan sekarang, atau lewat terminal:

```bash
meetresult whisper-status --model large-v3   # cek status
meetresult whisper-download --model large-v3 # unduh sekarang
```

### Provider Backup (Fallback) untuk Transkripsi

Kalau provider transkripsi utama gagal (error teknis, kuota API habis, internet putus, dll), MeetResult bisa otomatis mencoba ulang lewat provider backup, supaya transkripsi tetap berhasil dibuat. Atur lewat menu tray **Pengaturan** ("Fallback Transkripsi") atau `.env`:

```
TRANSCRIBE_PROVIDER=gemini
TRANSCRIBE_FALLBACK_PROVIDER=whisper
```

**Rekomendasi**: kalau provider utama cloud (Gemini/OpenAI), pakai `whisper` sebagai fallback — karena Whisper lokal tidak pernah kehabisan kuota/koneksi, transkripsi hampir pasti berhasil walau cloud sedang bermasalah. Kosongkan `TRANSCRIBE_FALLBACK_PROVIDER` untuk nonaktifkan (default).

**Model Whisper khusus untuk fallback**: kalau fallback-nya `whisper`, kamu bisa pakai model yang BEDA dari `WHISPER_MODEL` biasa lewat `WHISPER_FALLBACK_MODEL` (atau field "Model Whisper (Fallback)" di menu tray Pengaturan) - berguna kalau mau model utama paling akurat (mis. `large-v3`) tapi fallback darurat pakai model lebih cepat (mis. `medium`), supaya skenario cloud-down tidak ikut menunggu lama. Kosongkan untuk pakai model yang sama seperti `WHISPER_MODEL`.

```
WHISPER_MODEL=large-v3
WHISPER_FALLBACK_MODEL=medium
```

## 6. Setup Kalender

MeetResult mendukung 2 cara membaca kalender Outlook. Set lewat `CALENDAR_MODE` di `.env`.

### Mode A — `ics` (default, PALING MUDAH, tanpa Azure App)

Tidak perlu bikin aplikasi Azure/login OAuth apa pun. Kamu hanya perlu "publish" kalender:

1. Buka **Outlook Web** (outlook.office.com atau outlook.com)
2. Klik **Settings ⚙️** → **Calendar** → **Shared calendars**
3. Pilih kalender kamu → **Publish a calendar**
4. Permission: pilih **"Can view all details"** (bukan "Can view when I'm busy", agar judul & lokasi meeting ikut terbaca)
5. Klik **Publish**, lalu copy link yang formatnya **ICS** (bukan HTML)
6. Paste ke `.env`:
   ```
   CALENDAR_MODE=ics
   CALENDAR_ICS_URL=https://outlook.office365.com/owa/calendar/xxxxxxxx/calendar.ics
   ```
7. Selesai — **tidak perlu** `meetresult login`, langsung bisa `meetresult agenda` / `meetresult watch`

> Catatan: Outlook biasanya menyegarkan feed ICS ini setiap ~15–30 menit (bukan real-time), link join Teams diambil dari isi deskripsi/lokasi event, dan data **organizer/peserta tidak tersedia** di feed publish (dibatasi Microsoft untuk privasi) — jika butuh data ini lengkap, gunakan Mode B (`graph`).

### Mode B — `graph` (real-time, butuh Azure App Registration)

Gunakan jika butuh deteksi jadwal lebih real-time / data lebih lengkap.

1. Buka https://portal.azure.com → **Azure Active Directory** → **App registrations** → **New registration**
2. Nama: `MeetResult`, Supported account types: sesuai kebutuhan (Single/Multi tenant)
3. Tidak perlu Redirect URI (aplikasi ini pakai **Device Code Flow**), tapi jika diminta, tambahkan platform **Mobile and desktop applications** dengan URI `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Di **Authentication**, aktifkan **Allow public client flows** = Yes
5. Di **API permissions**, tambahkan Microsoft Graph (Delegated): `Calendars.Read`, `User.Read`, `OnlineMeetings.Read`
6. Copy **Application (client) ID** → masukkan ke `AZURE_CLIENT_ID`, dan set `CALENDAR_MODE=graph`
7. Untuk akun kantor (Office 365 organisasi), izin `Calendars.Read` biasanya tidak butuh admin consent, tapi tergantung kebijakan IT masing-masing perusahaan
8. Jalankan `meetresult login` sebelum pakai `agenda`/`watch`

## 7. Deteksi Meeting Aktif

Auto-record dipicu murni berdasarkan **jadwal kalender** (jam mulai–selesai), BUKAN status call Teams yang sebenarnya. Kalau event kalender masih ada tapi meeting-nya sebenarnya di-cancel/reschedule/tidak jadi, tanpa proteksi ini mic akan tetap merekam apapun yang terjadi di dekatnya selama window jadwal tersebut — termasuk percakapan pribadi di luar meeting.

Dua lapis proteksi otomatis aktif secara default:

1. **Cek Teams berjalan sebelum mulai** (`REQUIRE_TEAMS_RUNNING=true`, default) — kalau aplikasi Microsoft Teams sama sekali tidak dibuka saat jadwal mulai, auto-record dibatalkan (meeting ditandai status `skipped`).
2. **Cek ulang aktivitas audio setelah beberapa menit** (`SILENCE_CHECK_AFTER_MINUTES=5`, default) — kalau di menit ke-5 Teams TIDAK berjalan **dan** channel audio system (BlackHole, suara lawan bicara) diam total sejak mulai rekam, rekaman dihentikan otomatis dan **tidak diproses** (skip transkrip+notulen, hemat biaya AI & mencegah percakapan pribadi ikut dirangkum). File audio & transkrip yang sudah sempat terekam tetap disimpan (ikut retensi normal) untuk referensi manual kalau ternyata false-positive.

Kedua sinyal (Teams tidak jalan **dan** audio diam) harus sama-sama terpenuhi sebelum rekaman dihentikan — supaya meeting asli yang cuma hening di awal (nunggu peserta join, dsb) tidak salah dibuang. Set salah satu ke `false`/`0` di `.env` untuk menonaktifkan.

> Proteksi ini **tidak berlaku** untuk rekam manual (`meetresult record`) — itu selalu keputusan eksplisit kamu.

## 8. Cara Pakai

### Login ke Outlook

```bash
meetresult login
```
Ikuti instruksi kode device yang muncul (buka browser, masukkan kode). Hanya diperlukan untuk `CALENDAR_MODE=graph`.

### Cek device audio (sekali di awal, untuk setting `.env`)

```bash
meetresult devices
```

### Deteksi ulang server AI lokal untuk notulen (oMLX/Ollama/LM Studio)

```bash
meetresult setup-ai
```

### Cek daftar model & verifikasi provider AI

```bash
meetresult models      # daftar model tersedia untuk provider aktif
meetresult test-ai      # kirim transkrip kecil, pastikan provider/model benar-benar bekerja
```

### Lihat agenda meeting Teams

```bash
meetresult agenda --minutes 1440   # 1 hari ke depan
```

### Mode otomatis (rekomendasi) — jalankan di background/terminal terpisah

```bash
meetresult watch
```
Aplikasi akan memantau kalender setiap beberapa menit, otomatis mulai rekam saat meeting Teams dimulai, dan otomatis berhenti + transkrip + buat notulen saat meeting selesai.

### Rekam manual

```bash
meetresult record --name "Sync Mingguan Tim"
# ... setelah meeting selesai ...
meetresult stop
```

### Proses manual dari file audio yang sudah ada

```bash
meetresult process rekaman.wav --title "Rapat Anggaran Q4"
```

### Transkrip & ringkas terpisah

```bash
meetresult transcribe data/recordings/xxxx.wav
meetresult summarize data/transcripts/xxxx.txt --title "Rapat Anggaran Q4"
meetresult summarize data/transcripts/xxxx.txt --title "..." --model <id>   # override model sekali proses
```

### Lihat daftar & hasil notulen

```bash
meetresult list
meetresult show <meetingId>          # tampilkan ringkasan di terminal
meetresult show <meetingId> --open   # sekaligus buka file .docx di Word
```

### Bersihkan file audio lama secara manual (opsional)

```bash
meetresult cleanup
```
Secara default ini juga berjalan otomatis setiap hari jam 03:00 saat `meetresult watch` aktif.

## 9. Menu Bar App (macOS)

Ada indikator menu bar native (icon **"MR"**) supaya kamu bisa lihat status MeetResult sekilas, tanpa buka terminal:

```bash
meetresult tray
```

- 🟢 Hijau = Watch aktif standby, 🔴 Merah = sedang merekam otomatis, 🟡 Kuning = sedang merekam manual, ⚪ Abu-abu = semua berhenti

**Menu Watch (mode otomatis via kalender):**
- **Start** / **Stop** — kontrol watcher (setara `meetresult watch`)
- **Restart Watch** — restart manual watcher kapan saja (mis. setelah ubah `.env` manual di luar Pengaturan)
- Badge ⚠️ otomatis muncul kalau kode/konfigurasi berubah sejak watcher terakhir start, dengan opsi restart langsung

**Menu Rekam Manual (meeting di luar kalender, mis. panggilan dadakan/tidak terjadwal):**
- **Start** — dialog isi nama meeting, langsung mulai rekam
- **Stop** — hentikan rekaman manual, otomatis lanjut transkrip + generate MoM di background

**Event List** — daftar meeting hari ini + status, klik yang sudah selesai untuk buka notulennya

**Pengaturan...** — edit skema MoM, provider AI (Claude/OpenAI/Antigravity) + model, langsung dari UI native tanpa edit `.env` manual. Ada tombol **Test** untuk verifikasi provider/model yang sedang diisi sebelum disimpan.

**Lainnya:**
- **Buka Notulen** — buka folder `data/summaries` di Finder
- **Log Aktivitas** — buka `data/watcher.log`
- **Cek Update...** — cek versi terbaru dari GitHub repo (lihat [Update Aplikasi](#10-update-aplikasi))
- **Keluar** — tutup tray (watcher/rekaman yang sedang jalan tidak otomatis mati, stop dulu jika perlu)

Icon ini dibuat native pakai Swift/AppKit (`mac/MeetResultTray.swift`), tanpa dependency Electron yang berat. Jika source-nya diubah, compile ulang dengan:
```bash
bash mac/build.sh
```

> Agar tray otomatis jalan tiap Mac dinyalakan, tambahkan `meetresult tray` ke **System Settings → General → Login Items**.

## 10. Update Aplikasi

Repo: **https://github.com/aansun/MeetResult**

```bash
meetresult update              # cek apakah ada versi baru
meetresult update --apply      # cek + langsung terapkan (git pull && npm install)
```

Atau lewat menu bar: klik icon "MR" → **Cek Update...**

Cara kerja deteksi update:
- Kalau project ini hasil `git clone`, MeetResult bandingkan commit HEAD lokal vs `origin` (butuh koneksi internet, tidak perlu login apa pun).
- Kalau bukan git clone (mis. hasil download/extract manual), fallback ke pengecekan versi lewat `package.json` di GitHub secara langsung.

Update manual (kalau tidak pakai `--apply`):
```bash
git pull
npm install
```

> Setelah update kode, restart watcher (menu tray akan otomatis menawarkan "Restart Watch" begitu mendeteksi kode berubah) supaya perbaikan/fitur terbaru aktif.

## 11. Struktur Data

```
data/
  recordings/    # file audio .wav hasil rekaman (otomatis dihapus setelah AUDIO_RETENTION_DAYS hari)
  transcripts/
    2026-08/     # hasil transkripsi (.txt), dikelompokkan otomatis per bulan
  summaries/
    2026-08/     # notulen rapat (.docx) + data mentah (.json), dikelompokkan otomatis per bulan
  db.json        # metadata semua meeting

Template/
  MoM_*.pdf      # contoh template MoM perusahaan (referensi struktur dokumen)
```

> Folder bulanan (`YYYY-MM`) di `transcripts/` dan `summaries/` dibuat otomatis mengikuti tanggal meeting - supaya tidak menumpuk jadi satu folder besar seiring waktu.

## 12. Template MoM

Dokumen `.docx` yang dihasilkan memakai **template dinamis** (`Template/mom_template.docx`) berisi tag/placeholder, di-render otomatis pakai data hasil ringkasan AI. Strukturnya:

- **Header**: Subject, Hari/Tanggal, Media, Peserta, Disusun oleh
- **A. Pembahasan dan Kesepakatan**: tabel No, Topik, Status/Pembahasan, Kesepakatan
- **B. Action Items**: tabel No, Action Item, PIC, Target
- Catatan kaki

Nama file otomatis: `{JudulMeeting}_{YYYYMMDD}.docx` (jika ada duplikat, otomatis diberi sufiks `(2)`, `(3)`, dst).

### Dua skema MoM yang tersedia

| `MOM_TEMPLATE_TYPE` | Cocok untuk | Struktur |
|---|---|---|
| `structured` (default) | Rapat progress/review project mingguan | Tabel Pembahasan & Kesepakatan + tabel Action Items |
| `meeting_minutes` | Rapat formal/audit/review kebijakan | Resume naratif bernomor + tabel Attendances (Nama/Perusahaan/Jabatan) |

Ganti di `.env`:
```
MOM_TEMPLATE_TYPE=meeting_minutes
```
Template default masing-masing skema otomatis dipakai (`Template/mom_template.docx` atau `Template/mom_meeting_minutes_template.docx`) kecuali kamu override lewat `MOM_TEMPLATE_PATH`.

### Cara pakai TEMPLATE BARU (tanpa ubah kode)

Kalau kamu punya desain MoM baru dengan struktur/field YANG SAMA seperti salah satu skema di atas (misal beda logo, warna, kop surat perusahaan, tapi field-nya sama), begini caranya:

**1. Siapkan file `.docx`** (bukan PDF) dengan tag berikut persis (huruf besar/kecil harus sama):

| Tag | Diisi dengan |
|---|---|
| `{subject}` | Judul rapat |
| `{dateLabel}` | Hari/Tanggal (format Indonesia, otomatis) |
| `{media}` | Media rapat (mis. Online Meeting - Microsoft Teams) |
| `{participants}` | Daftar peserta |
| `{preparedBy}` | Nama penyusun (dari `MOM_PREPARED_BY`) |
| `{notes}` | Catatan tambahan/footer |

**2. Untuk tabel yang berulang** (Pembahasan & Action Items), buat 1 baris tabel sebagai "cetakan" yang akan diulang otomatis untuk tiap item:

- Tabel Pembahasan: taruh `{#discussion}` di **sel pertama** baris data (digabung dengan `{no}`), lalu `{topic}`, `{status}`, dan `{/discussion}` di **sel terakhir** (digabung dengan `{agreement}`).
  ```
  Sel 1: {#discussion}{no}   Sel 2: {topic}   Sel 3: {status}   Sel 4: {agreement}{/discussion}
  ```
- Tabel Action Items: sama polanya dengan `{#actionItems}` ... `{/actionItems}`, field: `{no}`, `{item}`, `{pic}`, `{target}`.

  Lihat contoh nyata di `Template/mom_template.docx` (buka di Word untuk lihat persis penempatan tag-nya) atau `scripts/generate-default-template.js` untuk lihat source code-nya.

**3. Simpan file template baru** ke folder `Template/`, misalnya `Template/mom_template_baru.docx`.

**4. Arahkan aplikasi ke template baru** — edit `.env`:
   ```
   MOM_TEMPLATE_PATH=Template/mom_template_baru.docx
   ```

**5. Selesai!** Jalankan `meetresult process`/`watch` seperti biasa — otomatis pakai template barumu, TANPA restart kode atau ubah program.

> ⚠️ **Penting untuk loop tabel/paragraf berulang (docxtemplater)**: tag pembuka `{#nama}` dan penutup `{/nama}` untuk PARAGRAF (seperti Resume) wajib ada di **paragraf terpisah/kosong** dari paragraf isi, kalau tidak item ke-2 dst akan menempel ke item sebelumnya. Untuk loop TABEL (baris), taruh tag pembuka di sel pertama & tag penutup di sel terakhir baris yang sama — ini sudah benar tanpa perlu paragraf terpisah. Lihat `scripts/generate-meeting-minutes-template.js` sebagai contoh referensi.

### Kalau field/kolom BENAR-BENAR baru (skema ke-3, dst)

Jika template barumu butuh field yang belum ada di kedua skema (mis. "Nomor Dokumen", "Approval", dsb), kasih tahu desainnya (kirim contoh PDF/Word) supaya bisa dibuatkan:
1. File `Template/mom_<nama>_template.docx` baru dengan tag sesuai
2. Skema baru di `src/summarize/schemas/<nama>Schema.js` (system prompt AI + mapping data)
3. Registrasi di `src/summarize/summarizer.js` supaya bisa dipilih lewat `MOM_TEMPLATE_TYPE=<nama>`

Proses ini hanya sekali per desain baru — setelah terdaftar, bisa dipakai berkali-kali cukup lewat `.env`.

## 13. Performa untuk Meeting Panjang (2+ jam)

Audio **tidak dipecah manual** — Whisper secara arsitektur internal sudah memproses audio panjang dalam jendela ~30 detik berurutan, jadi 1 file audio utuh (berapa pun durasinya) dikirim langsung ke Whisper apa adanya. Untuk mempercepat & menghemat resource pada meeting panjang, 2 optimasi bawaan `whisper-ctranslate2` diaktifkan secara default:

- **`WHISPER_BATCHED=true`** — proses beberapa segmen audio secara paralel dalam satu model (percepat 2-4x)
- **`WHISPER_VAD_FILTER=true`** — lewati bagian hening/silence (lebih cepat + mengurangi risiko halusinasi teks di bagian tanpa suara)

**Hasil benchmark nyata** (MacBook Apple M5, model `medium`, audio 14 menit 40 detik):

| Metrik | Hasil |
|---|---|
| Waktu transkripsi | 1 menit 50 detik (**~8x lebih cepat dari real-time**) |
| Estimasi meeting 2 jam | **~15 menit** |
| Peak RAM | ~5.7 GB (dari 16GB, sekitar 35%, hanya sesaat) |
| CPU | Multi-core (tidak membebani 1 core saja) |

**Perbandingan dengan `large-v3`** (model default saat ini, MacBook Apple M5, audio lain 12 menit 3 detik, setting `WHISPER_BATCHED`/`WHISPER_VAD_FILTER` sama):

| Metrik | `medium` | `large-v3` |
|---|---|---|
| Waktu transkripsi | ~1x kecepatan proporsional | **~4.2x lebih lambat** dari `medium` |
| Kecepatan vs real-time | ~6.6x lebih cepat | **~1.6x lebih cepat** (masih lebih cepat dari durasi audio, tapi jauh lebih tipis marginnya) |
| Estimasi meeting 2 jam | ~18 menit | **~1 jam 17 menit** |
| Ukuran model (unduhan pertama) | ~1.4 GB | **~2.9 GB** |

`large-v3` diverifikasi memperbaiki kesalahan transkripsi istilah Islam/Arab tertentu dibanding `medium` (mis. "Al-Khaliq" tidak lagi terbaca "alkoholik"), tapi **tidak** menjamin semua nama/istilah asing terbaca benar — untuk konten padat istilah spesifik seperti itu, kombinasikan dengan `WHISPER_HOTWORDS`/`WHISPER_INITIAL_PROMPT` (lihat bagian 5), atau pertimbangkan `TRANSCRIBE_PROVIDER=gemini` yang terbukti jauh lebih akurat untuk kasus ini.

Kalau meeting kamu sangat panjang/rutin dan waktu proses lebih penting daripada akurasi maksimal, turunkan `WHISPER_MODEL` ke `medium` (lebih cepat, akurasi tetap baik untuk percakapan umum) atau `small` (paling cepat). Kalau RAM terbatas (≤8GB), kecilkan `WHISPER_BATCH_SIZE` ke `4`.

## 14. Catatan Penting

- Perekaman **audio sistem** (suara peserta lain di Teams) memerlukan virtual audio device (BlackHole di macOS, Stereo Mix/VB-Cable di Windows, PulseAudio monitor di Linux) — ini batasan platform, bukan batasan aplikasi.
- Pastikan mematuhi kebijakan perusahaan & hukum setempat terkait **persetujuan perekaman rapat** (consent).
- Model Whisper `medium`/`large` lebih akurat untuk Bahasa Indonesia tapi butuh resource lebih besar.
- **Claude tidak bisa dipakai untuk transkripsi audio** (model Anthropic saat ini hanya menerima teks & gambar, bukan audio) — kalau `SUMMARY_PROVIDER=claude`, transkripsi tetap pakai Whisper/Gemini, baru hasil teksnya dikirim ke Claude untuk dibuat notulen.
- **Self-healing symlink Claude CLI (macOS)**: Claude Desktop auto-update ke versi baru kadang membuat symlink `claude` di PATH (mis. `/opt/homebrew/bin/claude`) jadi rusak (menunjuk ke folder versi lama yang sudah dihapus). Kalau Claude CLI dipakai (mode `cli`, sebagai provider utama ATAU fallback notulen), watcher otomatis cek & perbaiki symlink ini di setiap siklus polling — **tidak perlu restart apapun**, perbaikan langsung aktif untuk pemanggilan `claude` berikutnya.
