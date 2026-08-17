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
| `CLAUDE_MODE` | `cli` (default, pakai Claude Code yang sudah login, TANPA API key) atau `api` (pakai Anthropic API, berbayar per token) |
| `CLAUDE_CLI_BIN` | Nama/path binary Claude Code CLI (default `claude`) |
| `ANTHROPIC_API_KEY` | Hanya dipakai jika `CLAUDE_MODE=api`. Dari https://console.anthropic.com/settings/keys |
| `ANTHROPIC_MODEL` | Hanya dipakai jika `CLAUDE_MODE=api`. Default `claude-3-5-sonnet-latest` |
| `WHISPER_MODEL` | `small` / `medium` / `large` (makin besar makin akurat, makin lambat) |
| `WHISPER_BATCHED` | `true` (default) - percepat transkripsi 2-4x, penting untuk meeting panjang |
| `WHISPER_BATCH_SIZE` | Default `8`. Kecilkan ke `4` kalau RAM terbatas (≤8GB) |
| `WHISPER_VAD_FILTER` | `true` (default) - skip bagian hening/silence, lebih cepat & akurat |
| `WHISPER_LANGUAGE` | `id` untuk Bahasa Indonesia |
| `FFMPEG_AUDIO_DEVICE_INDEX` | Index/nama device audio input (lihat `meetresult devices`) |
| `AUDIO_RETENTION_DAYS` | Berapa hari file audio disimpan sebelum dihapus otomatis (default `3`) |
| `MOM_PREPARED_BY` | Nama yang tercantum di kolom "Disusun oleh" pada dokumen MoM |
| `MOM_ORG_NAME` | Nama program/organisasi opsional yang tampil sebagai subjudul dokumen |

### Setup Claude (mode CLI — default, direkomendasikan)

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
  transcripts/   # hasil transkripsi Whisper (.txt)
  summaries/     # notulen rapat (.docx) + data mentah (.json) hasil Claude
  db.json        # metadata semua meeting

Template/
  MoM_*.pdf      # contoh template MoM perusahaan (referensi struktur dokumen)
```

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
