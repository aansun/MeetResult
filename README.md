# MeetResult

CLI untuk **merekam, mentranskrip, dan membuat notulen/ringkasan rapat Microsoft Teams secara otomatis** — terinspirasi dari Krisp.ai — dengan integrasi **Outlook Calendar** dan AI **Claude**. Mendukung penuh **Bahasa Indonesia**.

## ✨ Fitur

- 🔗 **Integrasi Outlook Calendar** — deteksi otomatis jadwal meeting Teams
- ⏺️ **Auto-record** — mulai/berhenti rekam otomatis sesuai jadwal meeting
- ⌨️ **Rekam manual** — bisa juga direkam manual kapan saja
- 📝 **Transkripsi otomatis** (Whisper, offline, support Bahasa Indonesia)
- 🤖 **Notulen/MoM otomatis via Claude AI** — output **file Microsoft Word (.docx)** mengikuti template perusahaan (Subject, Hari/Tanggal, Media, Peserta, Pembahasan & Kesepakatan, Action Items)
- 📄 Nama file MoM otomatis unik: `{JudulMeeting}_{YYYYMMDD}.docx`
- 🗑️ **Retensi otomatis**: file audio rekaman dihapus otomatis setelah beberapa hari (default 3 hari, transkrip & MoM tetap disimpan)
- 💾 Semua hasil (audio, transkrip, notulen) tersimpan lokal di folder `data/`

## 🧩 Arsitektur Pipeline

```
Outlook Calendar (Graph API)
        │  deteksi meeting Teams terjadwal
        ▼
   Watcher (cron)
        │  saat waktu mulai tiba
        ▼
   Recorder (ffmpeg) ──► file .wav
        │  saat meeting selesai
        ▼
   Transcriber (Whisper, bahasa=id) ──► file .txt
        │
        ▼
   Summarizer (Claude API) ──► notulen .docx (template MoM)
        │
        ▼
   Retention Job ──► hapus audio > N hari (harian, jam 03:00)
```

## 📦 Instalasi

### 1. Prasyarat

- Node.js >= 18
- ffmpeg (`brew install ffmpeg`)
- Python + [whisper-ctranslate2](https://github.com/Softcatala/whisper-ctranslate2) untuk transkripsi (ringan & cepat, tanpa PyTorch, cocok untuk Apple Silicon):
  ```bash
  python3 -m pip install --user --upgrade pip
  python3 -m pip install --user -U whisper-ctranslate2
  whisper-ctranslate2 --help   # cek berhasil terinstall
  ```
  Model yang direkomendasikan: **`medium`** — akurasi bagus untuk Bahasa Indonesia, tetap cepat di chip Apple Silicon (M1/M2/M3/M4/M5). Gunakan `small` jika ingin lebih cepat dengan akurasi sedikit lebih rendah, atau `large-v3` jika butuh akurasi maksimal (lebih berat/lambat).
- **macOS**: agar bisa merekam **audio sistem** (suara Teams, bukan cuma mic), install virtual audio device:
  ```bash
  brew install blackhole-2ch
  ```
  Lalu buat **Multi-Output Device** / **Aggregate Device** di `Audio MIDI Setup` yang menggabungkan speaker + BlackHole, dan set BlackHole sebagai output audio saat meeting agar tetap terdengar sekaligus terekam.

### 2. Install dependency Node

```bash
cd MeetResult
npm install
```

### 2b. Daftarkan command `meetresult` secara global (WAJIB)

Supaya bisa jalankan `meetresult ...` dari terminal mana pun (bukan `node bin/meetresult.js ...`):

```bash
npm link
meetresult --version   # pastikan berhasil, tidak error "command not found"
```

> Kalau habis restart Mac / buka terminal baru muncul `zsh: command not found: meetresult`, biasanya karena langkah `npm link` ini belum pernah dijalankan di komputer tersebut — cukup jalankan sekali saja per komputer.

### 3. Konfigurasi

```bash
cp .env.example .env
```

Isi `.env`:

| Variabel | Keterangan |
|---|---|
| `AZURE_CLIENT_ID` | Client ID App Registration Azure AD (lihat langkah di bawah) |
| `AZURE_TENANT_ID` | `common` (default) atau tenant ID organisasi kamu |
| `SUMMARY_PROVIDER` | Provider AI untuk notulen: `claude` (default) atau `openai` (lihat [Setup Provider AI](#-setup-provider-ai-untuk-notulen)) |
| `CLAUDE_MODE` | `cli` (default, pakai Claude Code yang sudah login, TANPA API key) atau `api` (pakai Anthropic API, berbayar per token) |
| `CLAUDE_CLI_BIN` | Nama/path binary Claude Code CLI (default `claude`) |
| `ANTHROPIC_API_KEY` | Hanya dipakai jika `CLAUDE_MODE=api`. Dari https://console.anthropic.com/settings/keys |
| `ANTHROPIC_MODEL` | Hanya dipakai jika `CLAUDE_MODE=api`. Default `claude-3-5-sonnet-latest` |
| `OPENAI_BASE_URL` | Hanya dipakai jika `SUMMARY_PROVIDER=openai`. Default OpenAI cloud, atau arahkan ke server lokal (oMLX/Ollama/LM Studio) |
| `OPENAI_API_KEY` | Hanya dipakai jika `SUMMARY_PROVIDER=openai`. Kosongkan untuk server lokal yang tidak butuh auth |
| `OPENAI_MODEL` | Hanya dipakai jika `SUMMARY_PROVIDER=openai`. Nama model sesuai provider/server |
| `TRANSCRIBE_PROVIDER` | `whisper` (default, lokal/offline) atau `gemini` (butuh internet, lihat [Transkripsi via Gemini](#-transkripsi-via-gemini-opsional)) |
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

### 🤖 Setup Provider AI untuk Notulen

Step transkripsi (audio→teks) selalu pakai Whisper lokal — lihat catatan di [bagian bawah](#%EF%B8%8F-catatan-penting). Yang bisa dipilih providernya adalah step **notulen** (teks transkrip → JSON MoM), lewat `SUMMARY_PROVIDER` di `.env`:

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

#### Opsi A — `openai` dengan server LOKAL (privasi, gratis, offline)

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

#### Opsi B — `openai` dengan cloud (OpenAI atau provider OpenAI-compatible lain)

```
SUMMARY_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

#### Opsi C — `claude` (mode CLI — default, direkomendasikan)

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

#### Opsi D — `agy` (Antigravity CLI, akses model Gemini)

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

### 🎙️ Transkripsi via Gemini (opsional)

Default transkripsi (audio→teks) tetap **Whisper** (lokal, offline, gratis) - lihat [Prasyarat](#1-prasyarat). Sebagai alternatif, kamu bisa pakai **Gemini API** untuk transkripsi: Gemini bisa menerima file audio secara langsung (native audio understanding), beda dari Claude yang cuma menerima teks/gambar.

**Kapan pakai ini**: kalau tidak mau install Whisper secara lokal, atau ingin coba akurasi Gemini untuk audio yang sulit. **Trade-off**: butuh koneksi internet, dan audio meeting kamu terkirim ke server Google (bandingkan dengan Whisper yang 100% lokal).

1. Dapatkan API key di https://aistudio.google.com/apikey
2. Cek nama model **audio-capable** terbaru di Google AI Studio (nama model Gemini berubah dari waktu ke waktu, jadi sengaja tidak ada default bawaan di MeetResult)
3. Isi `.env`:
   ```
   TRANSCRIBE_PROVIDER=gemini
   GEMINI_API_KEY=...
   GEMINI_MODEL=...
   ```
4. Jalankan `meetresult transcribe <file.wav>` untuk tes

> Ini terpisah dari provider notulen (`SUMMARY_PROVIDER`) - kamu bisa campur, misalnya transkripsi pakai Gemini tapi notulen tetap pakai Claude, atau sebaliknya.

### Setup Kalender — pilih salah satu mode

MeetResult mendukung 2 cara membaca kalender Outlook. Set lewat `CALENDAR_MODE` di `.env`.

#### Mode A — `ics` (default, PALING MUDAH, tanpa Azure App)

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

#### Mode B — `graph` (real-time, butuh Azure App Registration)

Gunakan jika butuh deteksi jadwal lebih real-time / data lebih lengkap.

1. Buka https://portal.azure.com → **Azure Active Directory** → **App registrations** → **New registration**
2. Nama: `MeetResult`, Supported account types: sesuai kebutuhan (Single/Multi tenant)
3. Tidak perlu Redirect URI (aplikasi ini pakai **Device Code Flow**), tapi jika diminta, tambahkan platform **Mobile and desktop applications** dengan URI `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Di **Authentication**, aktifkan **Allow public client flows** = Yes
5. Di **API permissions**, tambahkan Microsoft Graph (Delegated): `Calendars.Read`, `User.Read`, `OnlineMeetings.Read`
6. Copy **Application (client) ID** → masukkan ke `AZURE_CLIENT_ID`, dan set `CALENDAR_MODE=graph`
7. Untuk akun kantor (Office 365 organisasi), izin `Calendars.Read` biasanya tidak butuh admin consent, tapi tergantung kebijakan IT masing-masing perusahaan
8. Jalankan `meetresult login` sebelum pakai `agenda`/`watch`

### 🛡️ Deteksi Meeting Aktif (mencegah auto-record yang bukan meeting)

Auto-record dipicu murni berdasarkan **jadwal kalender** (jam mulai–selesai), BUKAN status call Teams yang sebenarnya. Kalau event kalender masih ada tapi meeting-nya sebenarnya di-cancel/reschedule/tidak jadi, tanpa proteksi ini mic akan tetap merekam apapun yang terjadi di dekatnya selama window jadwal tersebut — termasuk percakapan pribadi di luar meeting.

Dua lapis proteksi otomatis aktif secara default:

1. **Cek Teams berjalan sebelum mulai** (`REQUIRE_TEAMS_RUNNING=true`, default) — kalau aplikasi Microsoft Teams sama sekali tidak dibuka saat jadwal mulai, auto-record dibatalkan (meeting ditandai status `skipped`).
2. **Cek ulang aktivitas audio setelah beberapa menit** (`SILENCE_CHECK_AFTER_MINUTES=5`, default) — kalau di menit ke-5 Teams TIDAK berjalan **dan** channel audio system (BlackHole, suara lawan bicara) diam total sejak mulai rekam, rekaman dihentikan otomatis dan **tidak diproses** (skip transkrip+notulen, hemat biaya AI & mencegah percakapan pribadi ikut dirangkum). File audio & transkrip yang sudah sempat terekam tetap disimpan (ikut retensi normal) untuk referensi manual kalau ternyata false-positive.

Kedua sinyal (Teams tidak jalan **dan** audio diam) harus sama-sama terpenuhi sebelum rekaman dihentikan — supaya meeting asli yang cuma hening di awal (nunggu peserta join, dsb) tidak salah dibuang. Set salah satu ke `false`/`0` di `.env` untuk menonaktifkan.

> Proteksi ini **tidak berlaku** untuk rekam manual (`meetresult record`) — itu selalu keputusan eksplisit kamu.

## 🚀 Cara Pakai

### Login ke Outlook

```bash
meetresult login
```
Ikuti instruksi kode device yang muncul (buka browser, masukkan kode).

### Cek device audio (sekali di awal, untuk setting `.env`)

```bash
meetresult devices
```

### Deteksi ulang server AI lokal untuk notulen (oMLX/Ollama/LM Studio)

```bash
meetresult setup-ai
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

## 💻 Menu Bar App (macOS)

Ada indikator menu bar native (icon **"MR"**) supaya kamu bisa lihat status MeetResult sekilas, tanpa buka terminal:

```bash
meetresult tray
```

- 🟢 Titik hijau = ada watcher ATAU rekaman manual yang sedang berjalan, ⚪ titik abu-abu = semua berhenti

**Mode otomatis (via kalender):**
- Menu **Start MeetResult (Watch)** — mulai watcher (setara `meetresult watch`)
- Menu **Stop MeetResult** — hentikan watcher

**Mode manual (meeting di luar kalender, mis. panggilan dadakan/tidak terjadwal):**
- Menu **Rekam Manual (di luar kalender)...** — muncul dialog untuk isi nama meeting, lalu langsung mulai rekam (setara `meetresult record --name "..."`)
- Menu **Stop & Proses Notulen** — hentikan rekaman manual, otomatis lanjut transkrip + generate MoM di background (setara `meetresult stop`)

**Lainnya:**
- Menu **Buka Folder Notulen (MoM)** — buka folder `data/summaries` di Finder
- Menu **Lihat Log Aktivitas** — buka `data/watcher.log`
- Menu **Cek Update...** — cek versi terbaru dari GitHub repo (lihat bagian [Update Aplikasi](#-update-aplikasi))
- Menu **Keluar** — tutup tray (watcher/rekaman yang sedang jalan tidak otomatis mati, stop dulu jika perlu)

Icon ini dibuat native pakai Swift/AppKit (`mac/MeetResultTray.swift`), tanpa dependency Electron yang berat. Jika source-nya diubah, compile ulang dengan:
```bash
bash mac/build.sh
```

> Agar tray otomatis jalan tiap Mac dinyalakan, tambahkan `meetresult tray` ke **System Settings → General → Login Items**.

## 🔄 Update Aplikasi

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

## 📁 Struktur Data

```
data/
  recordings/    # file audio .wav hasil rekaman (otomatis dihapus setelah AUDIO_RETENTION_DAYS hari)
  transcripts/
    2026-08/     # hasil transkripsi Whisper (.txt), dikelompokkan otomatis per bulan
  summaries/
    2026-08/     # notulen rapat (.docx) + data mentah (.json), dikelompokkan otomatis per bulan
  db.json        # metadata semua meeting

Template/
  MoM_*.pdf      # contoh template MoM perusahaan (referensi struktur dokumen)
```

> Folder bulanan (`YYYY-MM`) di `transcripts/` dan `summaries/` dibuat otomatis mengikuti tanggal meeting - supaya tidak menumpuk jadi satu folder besar seiring waktu.

## 📄 Template MoM

Dokumen `.docx` yang dihasilkan memakai **template dinamis** (`Template/mom_template.docx`) berisi tag/placeholder, di-render otomatis pakai data hasil ringkasan Claude. Strukturnya:

- **Header**: Subject, Hari/Tanggal, Media, Peserta, Disusun oleh
- **A. Pembahasan dan Kesepakatan**: tabel No, Topik, Status/Pembahasan, Kesepakatan
- **B. Action Items**: tabel No, Action Item, PIC, Target
- Catatan kaki

Nama file otomatis: `{JudulMeeting}_{YYYYMMDD}.docx` (jika ada duplikat, otomatis diberi sufiks `(2)`, `(3)`, dst).

### 📑 Dua skema MoM yang tersedia

| `MOM_TEMPLATE_TYPE` | Cocok untuk | Struktur |
|---|---|---|
| `structured` (default) | Rapat progress/review project mingguan | Tabel Pembahasan & Kesepakatan + tabel Action Items |
| `meeting_minutes` | Rapat formal/audit/review kebijakan | Resume naratif bernomor + tabel Attendances (Nama/Perusahaan/Jabatan) |

Ganti di `.env`:
```
MOM_TEMPLATE_TYPE=meeting_minutes
```
Template default masing-masing skema otomatis dipakai (`Template/mom_template.docx` atau `Template/mom_meeting_minutes_template.docx`) kecuali kamu override lewat `MOM_TEMPLATE_PATH`.

### 🔄 Cara pakai TEMPLATE BARU (tanpa ubah kode)

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

### ➕ Kalau field/kolom BENAR-BENAR baru (skema ke-3, dst)

Jika template barumu butuh field yang belum ada di kedua skema (mis. "Nomor Dokumen", "Approval", dsb), kasih tahu saya desainnya (kirim contoh PDF/Word) — saya akan:
1. Buat file `Template/mom_<nama>_template.docx` baru dengan tag sesuai
2. Buat skema baru di `src/summarize/schemas/<nama>Schema.js` (system prompt Claude + mapping data)
3. Daftarkan di `src/summarize/summarizer.js` supaya bisa dipilih lewat `MOM_TEMPLATE_TYPE=<nama>`

Proses ini hanya sekali per desain baru — setelah terdaftar, kamu bisa pakai berkali-kali cukup lewat `.env`.

## ⏱️ Performa untuk Meeting Panjang (2+ jam)

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

Kalau RAM terbatas (≤8GB) atau ingin lebih ringan, kecilkan `WHISPER_BATCH_SIZE` ke `4`, atau turunkan `WHISPER_MODEL` ke `small`.

## ⚠️ Catatan Penting

- Perekaman **audio sistem** (suara peserta lain di Teams) memerlukan virtual audio device (BlackHole di macOS, Stereo Mix/VB-Cable di Windows, PulseAudio monitor di Linux) — ini batasan platform, bukan batasan aplikasi.
- Pastikan mematuhi kebijakan perusahaan & hukum setempat terkait **persetujuan perekaman rapat** (consent).
- Model Whisper `medium`/`large` lebih akurat untuk Bahasa Indonesia tapi butuh resource lebih besar.
- **Claude tidak bisa dipakai untuk transkripsi audio** (model Anthropic saat ini hanya menerima teks & gambar, bukan audio). Transkripsi tetap memakai Whisper (lokal), lalu hasil teksnya baru dikirim ke Claude untuk dibuat notulen/ringkasan.
