import Cocoa

// MeetResultTray — Menu bar indicator untuk aplikasi MeetResult
// Icon: "MR" dengan titik status (hijau = ada aktivitas berjalan, abu-abu = semua berhenti)
// Menu (submenu per grup supaya ringkas):
//   Watch ▸ (Status, Start, Stop)
//   Rekam Manual ▸ (Status, Start, Stop)
//   Event List ▸ (daftar meeting yang sudah terdeteksi/diproses, klik untuk buka notulen)
//   Buka Notulen, Log Aktivitas, Cek Update, Keluar

let fm = FileManager.default

// Argumen pertama = path root project MeetResult (default: cwd saat dijalankan)
let projectDir: String = {
    if CommandLine.arguments.count > 1 {
        return CommandLine.arguments[1]
    }
    return fm.currentDirectoryPath
}()

let dataDir = projectDir + "/data"
let pidFile = dataDir + "/watcher.pid"
let watcherMetaFile = dataDir + "/watcher-meta.json"
let logFile = dataDir + "/watcher.log"
let summariesDir = dataDir + "/summaries"
let recordingStateFile = dataDir + "/recording-state.json"
let dbFile = dataDir + "/db.json"
let manualLogFile = dataDir + "/manual-record.log"
let nodeBin = "node"
let cliScript = "bin/meetresult.js"

/// Environment dictionary standar dipakai semua subprocess yang di-spawn tray (node/agy CLI) -
/// PATH diperluas ke lokasi umum tool CLI (Homebrew, pip user-install, dsb), dan NODE_OPTIONS
/// menekan ExperimentalWarning bawaan Node soal `localStorage` yang muncul akibat dependency
/// `docx` menyentuh globalThis.localStorage saat di-load - tidak relevan sama sekali dengan
/// MeetResult, cuma bikin log/output subprocess berisik.
func subprocessEnvironment(
    extraPaths: String = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/Library/Python/3.9/bin"
) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = extraPaths + ":" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    env["NODE_OPTIONS"] = "--disable-warning=ExperimentalWarning"
    return env
}

func statusIcon(_ status: String) -> String {
    switch status {
    case "scheduled": return "\u{1F5D3}\u{FE0F}"   // 🗓️
    case "recording": return "\u{1F534}"           // 🔴
    case "processing", "transcribed", "recorded": return "\u{23F3}" // ⏳
    case "done": return "\u{2705}"                 // ✅
    case "error": return "\u{26A0}\u{FE0F}"        // ⚠️
    case "skipped": return "\u{1F6AB}"             // 🚫
    default: return "\u{2022}"
    }
}

func parseIsoDate(_ iso: String) -> Date? {
    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = isoFormatter.date(from: iso) { return d }
    isoFormatter.formatOptions = [.withInternetDateTime]
    return isoFormatter.date(from: iso)
}

func formatShortDate(_ iso: String) -> String {
    guard let d = parseIsoDate(iso) else { return iso }
    let out = DateFormatter()
    out.dateFormat = "d MMM, HH:mm"
    out.locale = Locale(identifier: "id_ID")
    return out.string(from: d)
}

// MARK: - .env: baca/tulis minimalis (baris "KEY=value")

let envFilePath = projectDir + "/.env"

// ID model Claude yang diketahui - dipakai untuk isi awal dropdown di window Pengaturan.
// Combo box tetap bisa diketik manual kalau ada ID lain yang belum masuk daftar ini.
let knownClaudeModels = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]

// Model whisper-ctranslate2 yang didukung (dicek langsung dari `--help` binary terinstall,
// bukan tebakan) - dipakai untuk isi dropdown Model Whisper di window Pengaturan.
let knownWhisperModels = [
    "large-v3", "large-v3-turbo", "turbo", "medium", "small", "base", "tiny",
    "distil-large-v3.5", "distil-large-v3", "distil-large-v2",
    "large-v2", "large-v1", "medium.en", "small.en", "base.en", "tiny.en", "distil-medium.en", "distil-small.en",
]

// Model OpenAI Audio Transcriptions yang diketahui - dipakai untuk isi awal dropdown.
let knownOpenAiTranscribeModels = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]

// Label item dropdown Fallback saat fitur backup dinonaktifkan - dipetakan ke string kosong
// ("") di .env, bukan disimpan sebagai teks ini sendiri.
let fallbackDisabledLabel = "(Nonaktif)"

/// Baca versi aplikasi dari package.json - dipakai di footer "Tentang" window Pengaturan
/// supaya tidak perlu diupdate manual tiap kali versi berubah.
func readAppVersion() -> String {
    guard let data = fm.contents(atPath: projectDir + "/package.json"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let version = json["version"] as? String else { return "" }
    return version
}

func readEnvFile() -> String {
    (try? String(contentsOfFile: envFilePath, encoding: .utf8)) ?? ""
}

func readEnvValue(_ content: String, _ key: String) -> String {
    guard let range = content.range(
        of: "(?m)^\(NSRegularExpression.escapedPattern(for: key))=(.*)$",
        options: .regularExpression
    ) else { return "" }
    let line = String(content[range])
    return String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
}

func setEnvValue(_ content: String, _ key: String, _ value: String) -> String {
    let pattern = "(?m)^\(NSRegularExpression.escapedPattern(for: key))=.*$"
    if let range = content.range(of: pattern, options: .regularExpression) {
        return content.replacingCharacters(in: range, with: "\(key)=\(value)")
    }
    let needsNewline = !content.isEmpty && !content.hasSuffix("\n")
    return content + (needsNewline ? "\n" : "") + "\(key)=\(value)\n"
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!

    // Submenu Watch
    var watchStatusItem: NSMenuItem!
    var startItem: NSMenuItem!
    var stopItem: NSMenuItem!
    var restartStaleSeparator: NSMenuItem!
    var restartStaleItem: NSMenuItem!
    var hasNotifiedStale = false

    // Submenu Rekam Manual
    var manualStatusMenuItem: NSMenuItem!
    var recordManualItem: NSMenuItem!
    var stopManualItem: NSMenuItem!

    // Submenu Event List
    var eventListMenu: NSMenu!

    var settingsWindowController: SettingsWindowController?

    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // tidak muncul di Dock, hanya menu bar

        if !fm.fileExists(atPath: dataDir) {
            try? fm.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        }
        if !fm.fileExists(atPath: summariesDir) {
            try? fm.createDirectory(atPath: summariesDir, withIntermediateDirectories: true)
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        updateStatus()

        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    func buildMenu() {
        let menu = NSMenu()

        // --- Submenu: Watch (mode otomatis via kalender) ---
        let watchMenu = NSMenu()
        watchStatusItem = NSMenuItem(title: "Status: Mengecek...", action: nil, keyEquivalent: "")
        watchStatusItem.isEnabled = false
        watchMenu.addItem(watchStatusItem)
        watchMenu.addItem(NSMenuItem.separator())

        startItem = NSMenuItem(title: "Start", action: #selector(startWatcher), keyEquivalent: "s")
        startItem.target = self
        watchMenu.addItem(startItem)

        stopItem = NSMenuItem(title: "Stop", action: #selector(stopWatcher), keyEquivalent: "t")
        stopItem.target = self
        watchMenu.addItem(stopItem)

        // Muncul HANYA kalau watcher yang jalan masih pakai kode lama (source code berubah
        // setelah proses ini start) - lihat isWatcherCodeStale(). Restart TIDAK memutus
        // rekaman yang sedang berjalan (ffmpeg jalan sebagai proses detached terpisah).
        restartStaleSeparator = NSMenuItem.separator()
        restartStaleSeparator.isHidden = true
        watchMenu.addItem(restartStaleSeparator)

        restartStaleItem = NSMenuItem(
            title: "\u{26A0}\u{FE0F} Kode berubah - Restart Sekarang",
            action: #selector(restartWatcher),
            keyEquivalent: ""
        )
        restartStaleItem.target = self
        restartStaleItem.isHidden = true
        watchMenu.addItem(restartStaleItem)

        let watchMenuItem = NSMenuItem(title: "Watch", action: nil, keyEquivalent: "")
        watchMenuItem.submenu = watchMenu
        menu.addItem(watchMenuItem)

        // --- Submenu: Rekam Manual (di luar kalender) ---
        let manualMenu = NSMenu()
        manualStatusMenuItem = NSMenuItem(title: "Status: Mengecek...", action: nil, keyEquivalent: "")
        manualStatusMenuItem.isEnabled = false
        manualMenu.addItem(manualStatusMenuItem)
        manualMenu.addItem(NSMenuItem.separator())

        recordManualItem = NSMenuItem(title: "Start", action: #selector(startManualRecording), keyEquivalent: "r")
        recordManualItem.target = self
        manualMenu.addItem(recordManualItem)

        stopManualItem = NSMenuItem(title: "Stop", action: #selector(stopManualRecording), keyEquivalent: "x")
        stopManualItem.target = self
        manualMenu.addItem(stopManualItem)

        let manualMenuItem = NSMenuItem(title: "Rekam Manual", action: nil, keyEquivalent: "")
        manualMenuItem.submenu = manualMenu
        menu.addItem(manualMenuItem)

        menu.addItem(NSMenuItem.separator())

        // --- Submenu: Event List ---
        eventListMenu = NSMenu()
        let eventListMenuItem = NSMenuItem(title: "Event List", action: nil, keyEquivalent: "")
        eventListMenuItem.submenu = eventListMenu
        menu.addItem(eventListMenuItem)
        refreshEventList()

        menu.addItem(NSMenuItem.separator())

        let openSummary = NSMenuItem(title: "Buka Notulen", action: #selector(openSummaryFolder), keyEquivalent: "o")
        openSummary.target = self
        menu.addItem(openSummary)

        let openLog = NSMenuItem(title: "Log Aktivitas", action: #selector(openLogFile), keyEquivalent: "l")
        openLog.target = self
        menu.addItem(openLog)

        menu.addItem(NSMenuItem.separator())

        let settingsItem = NSMenuItem(title: "Pengaturan...", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        let checkUpdate = NSMenuItem(title: "Cek Update...", action: #selector(checkForUpdate), keyEquivalent: "u")
        checkUpdate.target = self
        menu.addItem(checkUpdate)

        menu.addItem(NSMenuItem.separator())

        // Restart manual Watch - sama seperti "Restart Sekarang" di submenu Watch (yang
        // cuma muncul saat kode/config terdeteksi berubah), tapi ini SELALU ada di menu
        // utama supaya bisa dipicu manual kapan saja tanpa perlu nunggu badge stale muncul.
        let restartWatchItem = NSMenuItem(title: "Restart Watch", action: #selector(restartWatcher), keyEquivalent: "")
        restartWatchItem.target = self
        menu.addItem(restartWatchItem)

        let quitItem = NSMenuItem(title: "Keluar", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - Event List

    /// Baca data/db.json, ambil meeting yang jadwalnya HARI INI saja (maks 15, urut kronologis),
    /// tampilkan di submenu "Event List". Meeting berstatus "done" bisa langsung diklik untuk
    /// buka notulennya.
    func refreshEventList() {
        eventListMenu.removeAllItems()

        guard let data = fm.contents(atPath: dbFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let meetings = json["meetings"] as? [[String: Any]],
              !meetings.isEmpty else {
            let empty = NSMenuItem(title: "Belum ada event terdeteksi", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            eventListMenu.addItem(empty)
            return
        }

        let todaysMeetings = meetings.filter { m in
            guard let start = m["start"] as? String, let date = parseIsoDate(start) else { return false }
            return Calendar.current.isDateInToday(date)
        }

        guard !todaysMeetings.isEmpty else {
            let empty = NSMenuItem(title: "Tidak ada event hari ini", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            eventListMenu.addItem(empty)
            return
        }

        let sorted = todaysMeetings.sorted { (a, b) in
            let sa = (a["start"] as? String) ?? ""
            let sb = (b["start"] as? String) ?? ""
            return sa < sb // urut kronologis (pagi -> malam)
        }

        for m in sorted.prefix(15) {
            let subject = (m["subject"] as? String) ?? "(Tanpa judul)"
            let status = (m["status"] as? String) ?? "unknown"
            let start = (m["start"] as? String) ?? ""
            let dateLabel = start.isEmpty ? "" : formatShortDate(start)
            let icon = statusIcon(status)

            let title = dateLabel.isEmpty ? "\(icon) \(subject)" : "\(icon) \(subject) — \(dateLabel)"
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")

            if status == "done", let summaryFile = m["summaryFile"] as? String, fm.fileExists(atPath: summaryFile) {
                item.action = #selector(openEventSummary(_:))
                item.target = self
                item.representedObject = summaryFile
            } else {
                item.isEnabled = false
            }

            eventListMenu.addItem(item)
        }
    }

    @objc func openEventSummary(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    // MARK: - Status checks

    /// Cari SEMUA PID proses "node .../meetresult.js watch" yang benar-benar berjalan lewat
    /// `pgrep` - sumber kebenaran untuk status watch, BUKAN cuma percaya pidFile. pidFile bisa
    /// tidak sinkron dengan proses yang sebenarnya berjalan (mis. race saat restart, atau
    /// proses crash tanpa sempat cleanup) - ini pernah nyata bikin ada watcher "nyasar" yang
    /// masih pakai config lama tanpa terdeteksi, sehingga perubahan .env (mis. ganti template)
    /// kelihatannya "tidak ngefek".
    func findAllWatcherPids() -> [Int32] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        task.arguments = ["-f", "meetresult.js watch"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return []
        }
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return output.split(separator: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// Bunuh SEMUA proses watcher yang ketemu (bukan cuma yang tercatat di pidFile) - mencegah
    /// proses "nyasar" tetap hidup dengan config lama setelah stop/restart, yang bisa membuat
    /// 2 proses watcher berjalan bersamaan dengan config berbeda.
    func killAllWatcherProcesses() {
        for pid in findAllWatcherPids() {
            kill(pid, SIGTERM)
        }
        try? fm.removeItem(atPath: pidFile)
        try? fm.removeItem(atPath: watcherMetaFile)
    }

    func isRunning() -> Bool {
        !findAllWatcherPids().isEmpty
    }

    /// Cek file data/recording-state.json (ditulis oleh recorder.js) untuk tahu apakah
    /// ADA PEREKAMAN AKTIF saat ini - dari sumber MANAPUN (baik dipicu otomatis oleh
    /// watcher/kalender, MAUPUN dari 'Rekam Manual'). Keduanya berbagi state file yang
    /// sama sehingga hanya SATU rekaman yang boleh berjalan dalam satu waktu.
    func isAnyRecordingActive() -> Bool {
        guard let data = fm.contents(atPath: recordingStateFile) else { return false }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }

        if let mode = json["mode"] as? String, mode == "dual" {
            guard let pids = json["pids"] as? [String: Any] else { return false }
            for (_, v) in pids {
                if let pid = (v as? NSNumber)?.int32Value, kill(pid, 0) == 0 {
                    return true
                }
            }
            return false
        }

        if let pid = (json["pid"] as? NSNumber)?.int32Value {
            return kill(pid, 0) == 0
        }
        return false
    }

    /// Meeting ID dari rekaman yang sedang aktif (kalau ada), untuk membedakan apakah
    /// itu dipicu otomatis oleh watcher (ID kalender) atau lewat 'Rekam Manual' (prefix "manual-").
    func activeRecordingMeetingId() -> String? {
        guard let data = fm.contents(atPath: recordingStateFile) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["meetingId"] as? String
    }

    /// Waktu proses watcher yang SEDANG jalan mulai di-start, dari data/watcher-meta.json
    /// (ditulis oleh `meetresult watch` sendiri). nil kalau file tidak ada (mis. watcher
    /// distart oleh versi lama sebelum fitur ini, atau memang tidak sedang jalan).
    func watcherStartedAt() -> Date? {
        guard let data = fm.contents(atPath: watcherMetaFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let iso = json["startedAt"] as? String else { return nil }
        return parseIsoDate(iso)
    }

    /// Waktu modifikasi TERBARU di antara semua file .js di src/ & bin/, PLUS file .env -
    /// dipakai sebagai proxy "kapan source code/konfigurasi terakhir berubah", baik lewat
    /// `git pull` (meetresult update), edit manual, MAUPUN lewat window Pengaturan.
    func latestSourceMtime() -> Date? {
        var latest: Date? = nil
        for subdir in ["src", "bin"] {
            let dir = projectDir + "/" + subdir
            guard let enumerator = fm.enumerator(atPath: dir) else { continue }
            while let file = enumerator.nextObject() as? String {
                guard file.hasSuffix(".js") else { continue }
                guard let attrs = try? fm.attributesOfItem(atPath: dir + "/" + file),
                      let modDate = attrs[.modificationDate] as? Date else { continue }
                if latest == nil || modDate > latest! { latest = modDate }
            }
        }
        if let attrs = try? fm.attributesOfItem(atPath: envFilePath),
           let modDate = attrs[.modificationDate] as? Date {
            if latest == nil || modDate > latest! { latest = modDate }
        }
        return latest
    }

    /// true kalau ada file source yang berubah SETELAH proses watcher yang sedang jalan
    /// di-start - artinya proses itu masih pakai kode LAMA di memori (Node.js tidak reload
    /// otomatis) dan perlu di-restart supaya perubahan (termasuk bugfix) benar-benar aktif.
    func isWatcherCodeStale() -> Bool {
        guard isRunning() else { return false }
        guard let startedAt = watcherStartedAt(), let latestSrc = latestSourceMtime() else { return false }
        return latestSrc > startedAt
    }

    func updateStatus() {
        let running = isRunning()
        let recordingActive = isAnyRecordingActive()
        let activeId = activeRecordingMeetingId()
        let isAutoTriggered = recordingActive && !(activeId?.hasPrefix("manual-") ?? false)
        let stale = isWatcherCodeStale()

        let attrTitle = NSMutableAttributedString()
        // Hijau = watch aktif & standby (belum merekam), Merah = sedang merekam otomatis
        // (dipicu watch/kalender), Kuning = sedang merekam manual, Abu-abu = semua berhenti.
        let dotColor: NSColor
        if recordingActive {
            dotColor = isAutoTriggered ? .systemRed : .systemYellow
        } else if running {
            dotColor = .systemGreen
        } else {
            dotColor = .systemGray
        }
        attrTitle.append(NSAttributedString(
            string: "\u{25CF} ", // ● - font kecil supaya tidak terlalu mencolok di menu bar
            attributes: [
                .foregroundColor: dotColor,
                .font: NSFont.systemFont(ofSize: 8),
                .baselineOffset: 1,
            ]
        ))
        attrTitle.append(NSAttributedString(
            string: stale ? "MR \u{26A0}\u{FE0F}" : "MR",
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.menuBarFont(ofSize: 13)
            ]
        ))
        statusItem.button?.attributedTitle = attrTitle

        watchStatusItem.title = running
            ? (stale ? "Status: Berjalan, kode berubah \u{26A0}\u{FE0F}" : "Status: Berjalan \u{2705}")
            : "Status: Berhenti \u{26D4}\u{FE0F}"
        startItem.isEnabled = !running
        stopItem.isEnabled = running
        restartStaleSeparator.isHidden = !stale
        restartStaleItem.isHidden = !stale

        if stale {
            if !hasNotifiedStale {
                hasNotifiedStale = true
                showNotification(
                    title: "MeetResult",
                    message: "Ada perubahan kode terbaru - restart Watch supaya perbaikan/fitur terbaru aktif (menu Watch > Restart Sekarang)."
                )
            }
        } else {
            hasNotifiedStale = false
        }

        // Rekaman manual HARUS nonaktif kalau sedang ada rekaman aktif dari sumber manapun
        // (termasuk yang dipicu otomatis oleh watcher/kalender) - hanya 1 rekaman boleh berjalan.
        if isAutoTriggered {
            manualStatusMenuItem.title = "Status: Terkunci (Watch merekam) \u{1F512}"
        } else if recordingActive {
            manualStatusMenuItem.title = "Status: Aktif \u{1F534}"
        } else {
            manualStatusMenuItem.title = "Status: Tidak Aktif"
        }
        recordManualItem.isEnabled = !recordingActive
        stopManualItem.isEnabled = recordingActive

        refreshEventList()
    }

    // MARK: - Helper: jalankan `meetresult <args...>` dengan PATH & cwd yang benar

    func buildMeetResultTask(_ args: [String], logPath: String) -> Process {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [nodeBin, cliScript] + args
        task.currentDirectoryURL = URL(fileURLWithPath: projectDir)

        task.environment = subprocessEnvironment()

        if !fm.fileExists(atPath: logPath) {
            fm.createFile(atPath: logPath, contents: nil)
        }
        if let logHandle = FileHandle(forWritingAtPath: logPath) {
            logHandle.seekToEndOfFile()
            task.standardOutput = logHandle
            task.standardError = logHandle
        }
        return task
    }

    // MARK: - Watch (mode otomatis via kalender)

    @objc func startWatcher() {
        if isRunning() {
            updateStatus()
            return
        }

        let task = buildMeetResultTask(["watch"], logPath: logFile)
        do {
            try task.run()
            try String(task.processIdentifier).write(toFile: pidFile, atomically: true, encoding: .utf8)
        } catch {
            showAlert(title: "Gagal menjalankan MeetResult", message: error.localizedDescription)
        }
        updateStatus()
    }

    /// Stop watcher SEKALIGUS rekaman yang sedang berjalan (kalau ada dan dipicu otomatis
    /// oleh watcher, BUKAN rekaman manual). Ini memperbaiki bug indikator: sebelumnya
    /// mematikan proses watcher saja tanpa menghentikan rekaman yang masih berjalan di
    /// belakang layar, sehingga titik status tetap hijau walau teks sudah "Berhenti".
    @objc func stopWatcher() {
        let wasRunning = isRunning()
        killAllWatcherProcesses()

        // Kalau ada rekaman aktif yang dipicu otomatis oleh watcher (bukan manual),
        // hentikan juga sekalian proses & buat notulennya (pakai `meetresult stop`).
        let activeId = activeRecordingMeetingId()
        let isAutoTriggered = isAnyRecordingActive() && !(activeId?.hasPrefix("manual-") ?? false)
        if isAutoTriggered {
            let task = buildMeetResultTask(["stop"], logPath: logFile)
            try? task.run()
            showNotification(
                title: "MeetResult",
                message: "Watch dihentikan. Rekaman yang sedang berjalan juga dihentikan & sedang diproses..."
            )
        }

        if !wasRunning && !isAutoTriggered {
            updateStatus()
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.updateStatus()
        }
    }

    /// Restart proses watcher supaya source code TERBARU kepakai (lihat isWatcherCodeStale()) -
    /// BEDA dari stopWatcher(): TIDAK menyentuh rekaman yang sedang aktif sama sekali, karena
    /// ffmpeg jalan sebagai proses detached terpisah dari watcher (lihat recorder.js) - proses
    /// watcher yang baru akan otomatis mengenali rekaman itu lagi lewat mekanisme reconcile
    /// di checkAndAct() pada siklus polling pertamanya.
    @objc func restartWatcher() {
        killAllWatcherProcesses()
        hasNotifiedStale = false

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            // Jaring pengaman kedua: pastikan benar-benar bersih (mis. proses lama butuh
            // lebih dari 1 detik untuk exit) sebelum start yang baru - supaya TIDAK PERNAH
            // ada 2 proses watcher berjalan bersamaan dengan config berbeda.
            self?.killAllWatcherProcesses()
            self?.startWatcher()
            self?.showNotification(title: "MeetResult", message: "Watch berhasil di-restart dengan kode terbaru.")
        }
    }

    // MARK: - Rekam manual (di luar kalender)

    @objc func startManualRecording() {
        if isAnyRecordingActive() {
            let autoTriggered = !(activeRecordingMeetingId()?.hasPrefix("manual-") ?? false)
            showAlert(
                title: "Tidak Bisa Mulai Rekam Manual",
                message: autoTriggered
                    ? "Watch sedang merekam meeting dari kalender. Hentikan dulu (Watch > Stop) sebelum mulai rekam manual - hanya 1 rekaman yang boleh berjalan bersamaan."
                    : "Sudah ada rekaman manual yang sedang berjalan. Hentikan dulu lewat menu Rekam Manual > Stop."
            )
            updateStatus()
            return
        }

        // Minta nama meeting lewat dialog kecil (opsional, boleh dikosongkan)
        let alert = NSAlert()
        alert.messageText = "Rekam Manual"
        alert.informativeText = "Masukkan nama/judul meeting (opsional):"
        alert.addButton(withTitle: "Mulai Rekam")
        alert.addButton(withTitle: "Batal")

        let inputField = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        let defaultName = "Meeting Manual"
        inputField.stringValue = defaultName
        alert.accessoryView = inputField
        alert.window.initialFirstResponder = inputField

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }

        let name = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let meetingName = name.isEmpty ? defaultName : name

        let task = buildMeetResultTask(["record", "--name", meetingName], logPath: manualLogFile)
        do {
            try task.run()
        } catch {
            showAlert(title: "Gagal memulai rekaman", message: error.localizedDescription)
        }

        // Beri jeda sedikit supaya recording-state.json sempat ditulis sebelum status di-refresh
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc func stopManualRecording() {
        if !isAnyRecordingActive() {
            updateStatus()
            return
        }

        let task = buildMeetResultTask(["stop"], logPath: manualLogFile)
        do {
            try task.run()
            showNotification(
                title: "MeetResult",
                message: "Rekaman dihentikan. Transkrip & notulen sedang diproses di background..."
            )
        } catch {
            showAlert(title: "Gagal menghentikan rekaman", message: error.localizedDescription)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.updateStatus()
        }
    }

    // MARK: - Lainnya

    @objc func openSummaryFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: summariesDir))
    }

    @objc func openLogFile() {
        if !fm.fileExists(atPath: logFile) {
            fm.createFile(atPath: logFile, contents: nil)
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: logFile))
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    @objc func openSettings() {
        if settingsWindowController == nil {
            settingsWindowController = SettingsWindowController(appDelegate: self)
        }
        settingsWindowController?.loadValues()
        settingsWindowController?.window?.center()
        settingsWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func checkForUpdate() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [nodeBin, cliScript, "update"]
        task.currentDirectoryURL = URL(fileURLWithPath: projectDir)

        task.environment = subprocessEnvironment()

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        do {
            try task.run()
        } catch {
            showAlert(title: "Cek Update", message: "Gagal cek update: \(error.localizedDescription)")
            return
        }

        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""

        // Ringkas jadi 1 kalimat hasil saja, bukan dump log mentah.
        let resultMessage: String
        if output.contains("Sudah versi terbaru") {
            resultMessage = "Sudah pakai versi terbaru \u{2705}"
        } else if output.contains("Update tersedia") {
            resultMessage = "Ada update baru tersedia! Jalankan 'meetresult update --apply' di terminal untuk memperbarui."
        } else if output.contains("Gagal") || output.contains("Error") {
            resultMessage = "Gagal cek update. Pastikan koneksi internet aktif."
        } else {
            resultMessage = "Tidak dapat menentukan status update."
        }

        showAlert(title: "Cek Update", message: resultMessage)
    }

    func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    func showNotification(title: String, message: String) {
        let notification = NSUserNotification()
        notification.title = title
        notification.informativeText = message
        NSUserNotificationCenter.default.deliver(notification)
    }
}

// MARK: - Window Pengaturan (edit .env langsung, UI minimalis)

class SettingsWindowController: NSWindowController {
    weak var appDelegate: AppDelegate?

    let templatePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let preparedByField = NSTextField(string: "")
    let orgNameField = NSTextField(string: "")
    let providerPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let summaryFallbackPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let claudeModePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let claudeCliModelField = NSComboBox()
    let claudeApiModelField = NSComboBox()
    let openaiBaseURLField = NSTextField(string: "")
    let openaiApiKeyField = NSSecureTextField(string: "")
    let openaiModelField = NSComboBox()
    let refreshModelsButton = NSButton(title: "\u{21BB}", target: nil, action: nil)
    let agyModelField = NSComboBox()
    let refreshAgyModelsButton = NSButton(title: "\u{21BB}", target: nil, action: nil)
    let testButton = NSButton(title: "Test", target: nil, action: nil)

    // --- Transkripsi (Local Whisper / Cloud Gemini / Cloud OpenAI) ---
    let transcribeProviderPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let transcribeFallbackPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let whisperModelField = NSComboBox()
    let whisperStatusLabel = NSTextField(labelWithString: "")
    let whisperActionButton = NSButton(title: "Cek Status", target: nil, action: nil)
    // Model Whisper KHUSUS untuk fallback (bisa beda dari model primary di atas, mis. model
    // lebih kecil/cepat untuk skenario darurat) - lihat WHISPER_FALLBACK_MODEL.
    let whisperFallbackModelField = NSComboBox()
    let whisperFallbackStatusLabel = NSTextField(labelWithString: "")
    let whisperFallbackActionButton = NSButton(title: "Cek Status", target: nil, action: nil)
    let geminiApiKeyField = NSSecureTextField(string: "")
    let geminiModelField = NSTextField(string: "")
    let openaiTranscribeApiKeyField = NSSecureTextField(string: "")
    let openaiTranscribeModelField = NSComboBox()

    var claudeRows: [NSStackView] = []
    var openaiRows: [NSStackView] = []
    var agyRows: [NSStackView] = []
    var whisperRows: [NSStackView] = []
    var whisperFallbackRows: [NSStackView] = []
    var geminiRows: [NSStackView] = []
    var openaiTranscribeRows: [NSStackView] = []
    var mainStack: NSStackView!
    private var envSnapshotBeforeTest: String?
    private var envMtimeBeforeTest: Date?
    private var whisperStatusCheckToken = 0
    private var whisperFallbackStatusCheckToken = 0

    convenience init(appDelegate: AppDelegate) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 60),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Pengaturan MeetResult"
        window.isReleasedWhenClosed = false
        self.init(window: window)
        self.appDelegate = appDelegate
        buildUI()
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.translatesAutoresizingMaskIntoConstraints = false
        box.widthAnchor.constraint(equalToConstant: 358).isActive = true
        return box
    }

    private func row(_ label: String, _ control: NSView, trailing: NSView? = nil) -> NSStackView {
        let labelField = NSTextField(labelWithString: label)
        labelField.alignment = .right
        labelField.translatesAutoresizingMaskIntoConstraints = false
        labelField.widthAnchor.constraint(equalToConstant: 130).isActive = true
        control.translatesAutoresizingMaskIntoConstraints = false
        control.widthAnchor.constraint(equalToConstant: trailing == nil ? 220 : 188).isActive = true
        var views: [NSView] = [labelField, control]
        if let trailing = trailing {
            trailing.translatesAutoresizingMaskIntoConstraints = false
            trailing.widthAnchor.constraint(equalToConstant: 24).isActive = true
            views.append(trailing)
        }
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.spacing = 8
        return stack
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.boldSystemFont(ofSize: 12)
        return label
    }

    func buildUI() {
        templatePopup.addItems(withTitles: ["structured", "meeting_minutes"])
        providerPopup.addItems(withTitles: ["claude", "openai", "agy"])
        claudeModePopup.addItems(withTitles: ["cli", "api"])
        providerPopup.target = self
        providerPopup.action = #selector(providerChanged)
        claudeModePopup.target = self
        claudeModePopup.action = #selector(claudeModeChanged)

        summaryFallbackPopup.addItems(withTitles: [fallbackDisabledLabel, "claude", "openai", "agy"])
        summaryFallbackPopup.toolTip = "Provider backup kalau provider utama gagal (error teknis, kuota habis, dll)"

        claudeCliModelField.addItems(withObjectValues: knownClaudeModels)
        claudeApiModelField.addItems(withObjectValues: knownClaudeModels)
        claudeCliModelField.placeholderString = "default Claude Code CLI"
        claudeApiModelField.placeholderString = "pilih atau ketik manual"

        refreshModelsButton.target = self
        refreshModelsButton.action = #selector(refreshOpenAIModels)
        refreshModelsButton.toolTip = "Ambil daftar model dari server (Base URL)"
        openaiModelField.placeholderString = "pilih dari daftar atau ketik manual"

        claudeRows = [
            row("Mode Claude:", claudeModePopup),
            row("Model (mode CLI):", claudeCliModelField),
            row("Model (mode API):", claudeApiModelField),
        ]
        let openaiBaseRow = row("Base URL:", openaiBaseURLField)
        let openaiKeyRow = row("API Key:", openaiApiKeyField)
        let openaiModelRow = row("Model:", openaiModelField, trailing: refreshModelsButton)
        openaiRows = [openaiBaseRow, openaiKeyRow, openaiModelRow]

        refreshAgyModelsButton.target = self
        refreshAgyModelsButton.action = #selector(refreshAgyModels)
        refreshAgyModelsButton.toolTip = "Ambil daftar model dari `agy models`"
        agyModelField.placeholderString = "kosongkan untuk default sesi agy"
        let agyModelRow = row("Model (Antigravity):", agyModelField, trailing: refreshAgyModelsButton)
        agyRows = [agyModelRow]

        // --- Transkripsi: Local (Whisper) / Cloud (Gemini) / Cloud (OpenAI) ---
        transcribeProviderPopup.addItems(withTitles: ["whisper", "gemini", "openai"])
        transcribeProviderPopup.target = self
        transcribeProviderPopup.action = #selector(transcribeProviderChanged)

        transcribeFallbackPopup.addItems(withTitles: [fallbackDisabledLabel, "whisper", "gemini", "openai"])
        transcribeFallbackPopup.toolTip = "Provider backup kalau provider utama gagal (error teknis, kuota habis, dll) - rekomendasi: whisper"
        transcribeFallbackPopup.target = self
        transcribeFallbackPopup.action = #selector(transcribeFallbackChanged)

        whisperModelField.addItems(withObjectValues: knownWhisperModels)
        whisperModelField.target = self
        whisperModelField.action = #selector(whisperModelChanged)
        whisperActionButton.target = self
        whisperActionButton.action = #selector(whisperActionButtonClicked)
        whisperStatusLabel.font = NSFont.systemFont(ofSize: 11)
        whisperStatusLabel.textColor = .secondaryLabelColor
        let whisperModelRow = row("Model Whisper (lokal):", whisperModelField, trailing: whisperActionButton)
        let whisperStatusRow = NSStackView(views: [NSView(), whisperStatusLabel])
        whisperStatusRow.orientation = .horizontal
        whisperRows = [whisperModelRow, whisperStatusRow]

        // Model Whisper khusus untuk peran FALLBACK - kosongkan untuk pakai model yang sama
        // dengan "Model Whisper (lokal)" di atas (lihat WHISPER_FALLBACK_MODEL).
        whisperFallbackModelField.addItems(withObjectValues: knownWhisperModels)
        whisperFallbackModelField.placeholderString = "kosongkan untuk pakai model yang sama seperti di atas"
        whisperFallbackModelField.target = self
        whisperFallbackModelField.action = #selector(whisperFallbackModelChanged)
        whisperFallbackActionButton.target = self
        whisperFallbackActionButton.action = #selector(whisperFallbackActionButtonClicked)
        whisperFallbackStatusLabel.font = NSFont.systemFont(ofSize: 11)
        whisperFallbackStatusLabel.textColor = .secondaryLabelColor
        let whisperFallbackModelRow = row("Model Whisper (Fallback):", whisperFallbackModelField, trailing: whisperFallbackActionButton)
        let whisperFallbackStatusRow = NSStackView(views: [NSView(), whisperFallbackStatusLabel])
        whisperFallbackStatusRow.orientation = .horizontal
        whisperFallbackRows = [whisperFallbackModelRow, whisperFallbackStatusRow]

        geminiModelField.placeholderString = "cek nama model audio-capable terbaru di Google AI Studio"
        openaiTranscribeApiKeyField.placeholderString = "kosongkan untuk pakai API Key OpenAI notulen di atas"
        let geminiKeyRow = row("Gemini API Key:", geminiApiKeyField)
        let geminiModelRow = row("Gemini Model:", geminiModelField)
        geminiRows = [geminiKeyRow, geminiModelRow]

        openaiTranscribeModelField.addItems(withObjectValues: knownOpenAiTranscribeModels)
        let openaiTranscribeKeyRow = row("OpenAI API Key:", openaiTranscribeApiKeyField)
        let openaiTranscribeModelRow = row("OpenAI Model:", openaiTranscribeModelField)
        openaiTranscribeRows = [openaiTranscribeKeyRow, openaiTranscribeModelRow]

        testButton.target = self
        testButton.action = #selector(testCurrentModel)
        testButton.toolTip = "Kirim transkrip kecil ke provider/model yang sedang diisi, tanpa buat file/rekaman"

        let saveButton = NSButton(title: "Simpan", target: self, action: #selector(saveSettings))
        saveButton.keyEquivalent = "\r"
        let cancelButton = NSButton(title: "Batal", target: self, action: #selector(closeWindow))
        let buttonRow = NSStackView(views: [testButton, NSView(), cancelButton, saveButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8

        let version = readAppVersion()
        let aboutLabel = NSTextField(labelWithString: "MeetResult\(version.isEmpty ? "" : " v\(version)") \u{2014} by aansun")
        aboutLabel.font = NSFont.systemFont(ofSize: 11)
        aboutLabel.textColor = .secondaryLabelColor

        mainStack = NSStackView(views: [
            sectionLabel("Notulen (MoM)"),
            row("Skema:", templatePopup),
            row("Disusun oleh:", preparedByField),
            row("Nama Organisasi:", orgNameField),
            separator(),
            sectionLabel("Provider AI (Notulen)"),
            row("Provider:", providerPopup),
            row("Provider Fallback:", summaryFallbackPopup),
            claudeRows[0], claudeRows[1], claudeRows[2],
            openaiBaseRow, openaiKeyRow, openaiModelRow,
            agyRows[0],
            separator(),
            sectionLabel("Transkripsi (Audio \u{2192} Teks)"),
            row("Provider Transkripsi:", transcribeProviderPopup),
            row("Fallback Transkripsi:", transcribeFallbackPopup),
            whisperRows[0], whisperRows[1],
            whisperFallbackRows[0], whisperFallbackRows[1],
            geminiRows[0], geminiRows[1],
            openaiTranscribeRows[0], openaiTranscribeRows[1],
            separator(),
            buttonRow,
            separator(),
            aboutLabel,
        ])
        mainStack.orientation = .vertical
        mainStack.alignment = .leading
        mainStack.spacing = 10
        mainStack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        buttonRow.widthAnchor.constraint(equalToConstant: 358).isActive = true

        let contentView = NSView()
        contentView.addSubview(mainStack)
        NSLayoutConstraint.activate([
            mainStack.topAnchor.constraint(equalTo: contentView.topAnchor),
            mainStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            mainStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            mainStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        window?.contentView = contentView
        resizeToFitContent()
    }

    /// Hitung ulang & terapkan ukuran window pas dengan konten yang SEDANG terlihat -
    /// wajib dipanggil ulang tiap kali baris disembunyikan/dimunculkan (lihat
    /// providerChanged()), karena NSStackView.fittingSize berubah begitu ada arranged
    /// subview yang isHidden-nya berubah, tapi window TIDAK otomatis mengikuti.
    private func resizeToFitContent() {
        window?.layoutIfNeeded()
        window?.setContentSize(mainStack.fittingSize)
    }

    @objc func providerChanged() {
        let selected = providerPopup.titleOfSelectedItem ?? "claude"
        claudeRows.forEach { $0.isHidden = selected != "claude" }
        openaiRows.forEach { $0.isHidden = selected != "openai" }
        agyRows.forEach { $0.isHidden = selected != "agy" }
        resizeToFitContent()
    }

    @objc func transcribeProviderChanged() {
        let selected = transcribeProviderPopup.titleOfSelectedItem ?? "whisper"
        whisperRows.forEach { $0.isHidden = selected != "whisper" }
        geminiRows.forEach { $0.isHidden = selected != "gemini" }
        openaiTranscribeRows.forEach { $0.isHidden = selected != "openai" }
        if selected == "whisper" {
            checkWhisperModelStatus()
        }
        resizeToFitContent()
    }

    /// Toggle field "Model Whisper (Fallback)" - independen dari transcribeProviderChanged()
    /// karena fallback bisa "whisper" walau provider utamanya BUKAN whisper (mis. utama Gemini,
    /// fallback Whisper lokal) - lihat WHISPER_FALLBACK_MODEL di config.js.
    @objc func transcribeFallbackChanged() {
        let selected = transcribeFallbackPopup.titleOfSelectedItem ?? fallbackDisabledLabel
        whisperFallbackRows.forEach { $0.isHidden = selected != "whisper" }
        if selected == "whisper" {
            checkWhisperFallbackModelStatus()
        }
        resizeToFitContent()
    }

    @objc func whisperModelChanged() {
        checkWhisperModelStatus()
    }

    @objc func whisperFallbackModelChanged() {
        checkWhisperFallbackModelStatus()
    }

    private func checkWhisperModelStatus() {
        checkWhisperModelStatus(
            modelField: whisperModelField, statusLabel: whisperStatusLabel, actionButton: whisperActionButton,
            bumpToken: { [weak self] in
                self?.whisperStatusCheckToken += 1
                return self?.whisperStatusCheckToken ?? 0
            },
            isCurrentToken: { [weak self] t in t == self?.whisperStatusCheckToken }
        )
    }

    private func checkWhisperFallbackModelStatus() {
        checkWhisperModelStatus(
            modelField: whisperFallbackModelField, statusLabel: whisperFallbackStatusLabel, actionButton: whisperFallbackActionButton,
            bumpToken: { [weak self] in
                self?.whisperFallbackStatusCheckToken += 1
                return self?.whisperFallbackStatusCheckToken ?? 0
            },
            isCurrentToken: { [weak self] t in t == self?.whisperFallbackStatusCheckToken }
        )
    }

    /// Cek apakah model Whisper yang sedang diisi di `modelField` sudah ada di cache lokal,
    /// lewat `meetresult whisper-status` (bukan cek manual folder cache - biar konsisten dengan
    /// logika resolve model yang sebenarnya dipakai faster-whisper). Dipakai bareng oleh field
    /// Model Whisper primary DAN fallback - `bumpToken`/`isCurrentToken` mencegah race kalau
    /// user ganti-ganti model dengan cepat (masing-masing field punya token counter sendiri).
    private func checkWhisperModelStatus(
        modelField: NSComboBox, statusLabel: NSTextField, actionButton: NSButton,
        bumpToken: @escaping () -> Int, isCurrentToken: @escaping (Int) -> Bool
    ) {
        let model = modelField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !model.isEmpty else {
            statusLabel.stringValue = ""
            return
        }
        let myToken = bumpToken()
        statusLabel.stringValue = "Mengecek status model..."
        actionButton.isEnabled = false

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [nodeBin, cliScript, "whisper-status", "--model", model]
        task.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        task.environment = subprocessEnvironment()
        let stdoutPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = Pipe()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            try? task.run()
            task.waitUntilExit()
            let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                guard let self = self, isCurrentToken(myToken) else { return }
                actionButton.isEnabled = true
                guard let jsonData = output.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                      let cached = json["cached"] as? Bool else {
                    statusLabel.stringValue = "\u{26A0}\u{FE0F} Gagal cek status (python3/faster-whisper tidak ditemukan)"
                    actionButton.title = "Cek Status"
                    return
                }
                if cached {
                    statusLabel.stringValue = "\u{2705} Model sudah tersedia di lokal"
                    actionButton.title = "Cek Status"
                } else {
                    statusLabel.stringValue = "\u{2B07}\u{FE0F} Belum diunduh - klik \"Unduh\" untuk unduh sekarang"
                    actionButton.title = "Unduh"
                }
                self.resizeToFitContent()
            }
        }
    }

    /// Tombol Model Whisper (primary): "Cek Status" cuma mengecek ulang, "Unduh" memicu
    /// unduhan nyata (bisa beberapa menit & GB tergantung model) lewat `meetresult whisper-download`.
    @objc func whisperActionButtonClicked() {
        if whisperActionButton.title == "Unduh" {
            downloadWhisperModel(
                modelField: whisperModelField, statusLabel: whisperStatusLabel, actionButton: whisperActionButton,
                onDone: { [weak self] in self?.checkWhisperModelStatus() }
            )
        } else {
            checkWhisperModelStatus()
        }
    }

    /// Sama seperti whisperActionButtonClicked(), tapi untuk field Model Whisper (Fallback).
    @objc func whisperFallbackActionButtonClicked() {
        if whisperFallbackActionButton.title == "Unduh" {
            downloadWhisperModel(
                modelField: whisperFallbackModelField, statusLabel: whisperFallbackStatusLabel, actionButton: whisperFallbackActionButton,
                onDone: { [weak self] in self?.checkWhisperFallbackModelStatus() }
            )
        } else {
            checkWhisperFallbackModelStatus()
        }
    }

    private func downloadWhisperModel(
        modelField: NSComboBox, statusLabel: NSTextField, actionButton: NSButton, onDone: @escaping () -> Void
    ) {
        let model = modelField.stringValue.trimmingCharacters(in: .whitespaces)
        guard !model.isEmpty else { return }

        actionButton.isEnabled = false
        actionButton.title = "Mengunduh..."
        statusLabel.stringValue = "Mengunduh model '\(model)' - bisa beberapa menit tergantung ukuran model & koneksi..."

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [nodeBin, cliScript, "whisper-download", "--model", model]
        task.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        task.environment = subprocessEnvironment()
        task.standardOutput = Pipe()
        task.standardError = Pipe()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try task.run()
            } catch {
                DispatchQueue.main.async {
                    self?.appDelegate?.showAlert(title: "Gagal Mengunduh", message: error.localizedDescription)
                    onDone()
                }
                return
            }
            task.waitUntilExit()
            DispatchQueue.main.async {
                if task.terminationStatus != 0 {
                    self?.appDelegate?.showAlert(
                        title: "Gagal Mengunduh Model",
                        message: "Unduhan model '\(model)' gagal (kode \(task.terminationStatus)). Cek koneksi internet & coba lagi."
                    )
                }
                onDone()
            }
        }
    }

    /// Ambil daftar model dari `agy models` (shell-out, mirip refreshOpenAIModels() tapi lewat
    /// CLI bukan HTTP) dan isi dropdown Model (Antigravity).
    @objc func refreshAgyModels() {
        refreshAgyModelsButton.isEnabled = false
        refreshAgyModelsButton.title = "\u{22EF}"

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [config_agyCliBin(), "models"]
        task.environment = subprocessEnvironment(
            extraPaths: "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin:\(NSHomeDirectory())/Library/Python/3.9/bin"
        )

        let stdoutPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = Pipe()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try task.run()
            } catch {
                DispatchQueue.main.async {
                    self?.refreshAgyModelsButton.isEnabled = true
                    self?.refreshAgyModelsButton.title = "\u{21BB}"
                    self?.appDelegate?.showAlert(title: "Gagal ambil daftar model", message: error.localizedDescription)
                }
                return
            }
            task.waitUntilExit()
            let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            let ids = output
                .split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !$0.lowercased().hasPrefix("fetching") }
                .compactMap { $0.split(separator: "\t").first.map(String.init) }

            DispatchQueue.main.async {
                guard let self = self else { return }
                self.refreshAgyModelsButton.isEnabled = true
                self.refreshAgyModelsButton.title = "\u{21BB}"
                if ids.isEmpty {
                    self.appDelegate?.showAlert(
                        title: "Tidak ada model",
                        message: "Gagal membaca daftar model dari 'agy models'. Pastikan agy terinstall & sudah login."
                    )
                    return
                }
                let current = self.agyModelField.stringValue
                self.agyModelField.removeAllItems()
                self.agyModelField.addItems(withObjectValues: ids)
                self.agyModelField.stringValue = current
            }
        }
    }

    private func config_agyCliBin() -> String {
        let content = readEnvFile()
        let bin = readEnvValue(content, "AGY_CLI_BIN")
        return bin.isEmpty ? "agy" : bin
    }

    /// Nonaktifkan field model yang TIDAK relevan dengan mode Claude yang sedang dipilih -
    /// CLAUDE_CLI_MODEL cuma dipakai kalau mode "cli", ANTHROPIC_MODEL cuma kalau mode "api".
    /// Ini juga yang memperbaiki kasus salah isi field (mis. isi ANTHROPIC_MODEL padahal mode
    /// masih "cli" sehingga perubahannya tidak pernah kepakai).
    @objc func claudeModeChanged() {
        let isApi = claudeModePopup.titleOfSelectedItem == "api"
        claudeCliModelField.isEnabled = !isApi
        claudeApiModelField.isEnabled = isApi
    }

    /// Ambil daftar model dari endpoint OpenAI-compatible yang sedang diisi di field Base URL
    /// (+ API Key kalau ada), lalu isi dropdown Model - berguna untuk server lokal (oMLX/
    /// Ollama/LM Studio) yang nama modelnya sering tidak baku/sulit ditebak manual.
    @objc func refreshOpenAIModels() {
        var base = openaiBaseURLField.stringValue.trimmingCharacters(in: .whitespaces)
        if base.isEmpty { base = "https://api.openai.com/v1" }
        while base.hasSuffix("/") { base.removeLast() }

        guard let url = URL(string: base + "/models") else {
            appDelegate?.showAlert(title: "URL tidak valid", message: "Cek isian Base URL.")
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        let apiKey = openaiApiKeyField.stringValue
        if !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        refreshModelsButton.isEnabled = false
        refreshModelsButton.title = "\u{22EF}"

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.refreshModelsButton.isEnabled = true
                self.refreshModelsButton.title = "\u{21BB}"

                guard let data = data, error == nil,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let list = json["data"] as? [[String: Any]] else {
                    self.appDelegate?.showAlert(
                        title: "Gagal ambil daftar model",
                        message: error?.localizedDescription ?? "Response dari server tidak sesuai format yang diharapkan."
                    )
                    return
                }

                let ids = list.compactMap { $0["id"] as? String }.sorted()
                if ids.isEmpty {
                    self.appDelegate?.showAlert(title: "Tidak ada model", message: "Endpoint ini tidak mengembalikan daftar model.")
                    return
                }

                let current = self.openaiModelField.stringValue
                self.openaiModelField.removeAllItems()
                self.openaiModelField.addItems(withObjectValues: ids)
                self.openaiModelField.stringValue = current.isEmpty ? ids[0] : current
            }
        }.resume()
    }

    /// Baca ulang .env & isi semua field - dipanggil setiap window dibuka, supaya selalu
    /// menampilkan nilai TERKINI (mis. kalau ada perubahan manual di .env sejak terakhir dibuka).
    func loadValues() {
        let content = readEnvFile()

        let templateType = readEnvValue(content, "MOM_TEMPLATE_TYPE")
        templatePopup.selectItem(withTitle: templateType.isEmpty ? "structured" : templateType)

        preparedByField.stringValue = readEnvValue(content, "MOM_PREPARED_BY")
        orgNameField.stringValue = readEnvValue(content, "MOM_ORG_NAME")

        let provider = readEnvValue(content, "SUMMARY_PROVIDER")
        providerPopup.selectItem(withTitle: provider.isEmpty ? "claude" : provider)

        let summaryFallback = readEnvValue(content, "SUMMARY_FALLBACK_PROVIDER")
        summaryFallbackPopup.selectItem(withTitle: summaryFallback.isEmpty ? fallbackDisabledLabel : summaryFallback)

        let claudeMode = readEnvValue(content, "CLAUDE_MODE")
        claudeModePopup.selectItem(withTitle: claudeMode.isEmpty ? "cli" : claudeMode)
        claudeCliModelField.stringValue = readEnvValue(content, "CLAUDE_CLI_MODEL")
        claudeApiModelField.stringValue = readEnvValue(content, "ANTHROPIC_MODEL")
        claudeModeChanged()

        openaiBaseURLField.stringValue = readEnvValue(content, "OPENAI_BASE_URL")
        openaiApiKeyField.stringValue = readEnvValue(content, "OPENAI_API_KEY")
        openaiModelField.removeAllItems()
        openaiModelField.stringValue = readEnvValue(content, "OPENAI_MODEL")

        agyModelField.removeAllItems()
        agyModelField.stringValue = readEnvValue(content, "AGY_MODEL")

        providerChanged()

        let transcribeProvider = readEnvValue(content, "TRANSCRIBE_PROVIDER")
        transcribeProviderPopup.selectItem(withTitle: transcribeProvider.isEmpty ? "whisper" : transcribeProvider)

        let transcribeFallback = readEnvValue(content, "TRANSCRIBE_FALLBACK_PROVIDER")
        transcribeFallbackPopup.selectItem(withTitle: transcribeFallback.isEmpty ? fallbackDisabledLabel : transcribeFallback)

        let whisperModel = readEnvValue(content, "WHISPER_MODEL")
        whisperModelField.stringValue = whisperModel.isEmpty ? "large-v3" : whisperModel
        whisperFallbackModelField.stringValue = readEnvValue(content, "WHISPER_FALLBACK_MODEL")
        geminiApiKeyField.stringValue = readEnvValue(content, "GEMINI_API_KEY")
        geminiModelField.stringValue = readEnvValue(content, "GEMINI_MODEL")
        openaiTranscribeApiKeyField.stringValue = readEnvValue(content, "OPENAI_TRANSCRIBE_API_KEY")
        openaiTranscribeModelField.stringValue = readEnvValue(content, "OPENAI_TRANSCRIBE_MODEL")

        transcribeProviderChanged()
        transcribeFallbackChanged()
    }

    /// Terapkan isi form SEKARANG ke teks .env (belum ditulis ke disk) - dipakai bareng oleh
    /// saveSettings() (Simpan) dan testCurrentModel() (Test, supaya tes memvalidasi apa yang
    /// SEDANG diisi di form, termasuk perubahan yang belum di-Simpan).
    private func applyFormToEnvContent(_ base: String) -> String {
        var content = base
        content = setEnvValue(content, "MOM_TEMPLATE_TYPE", templatePopup.titleOfSelectedItem ?? "structured")
        content = setEnvValue(content, "MOM_PREPARED_BY", preparedByField.stringValue)
        content = setEnvValue(content, "MOM_ORG_NAME", orgNameField.stringValue)
        content = setEnvValue(content, "SUMMARY_PROVIDER", providerPopup.titleOfSelectedItem ?? "claude")
        let summaryFallbackValue = summaryFallbackPopup.titleOfSelectedItem ?? fallbackDisabledLabel
        content = setEnvValue(content, "SUMMARY_FALLBACK_PROVIDER", summaryFallbackValue == fallbackDisabledLabel ? "" : summaryFallbackValue)
        content = setEnvValue(content, "CLAUDE_MODE", claudeModePopup.titleOfSelectedItem ?? "cli")
        content = setEnvValue(content, "CLAUDE_CLI_MODEL", claudeCliModelField.stringValue)
        content = setEnvValue(content, "ANTHROPIC_MODEL", claudeApiModelField.stringValue)
        content = setEnvValue(content, "OPENAI_BASE_URL", openaiBaseURLField.stringValue)
        content = setEnvValue(content, "OPENAI_API_KEY", openaiApiKeyField.stringValue)
        content = setEnvValue(content, "OPENAI_MODEL", openaiModelField.stringValue)
        content = setEnvValue(content, "AGY_MODEL", agyModelField.stringValue)
        content = setEnvValue(content, "TRANSCRIBE_PROVIDER", transcribeProviderPopup.titleOfSelectedItem ?? "whisper")
        let transcribeFallbackValue = transcribeFallbackPopup.titleOfSelectedItem ?? fallbackDisabledLabel
        content = setEnvValue(content, "TRANSCRIBE_FALLBACK_PROVIDER", transcribeFallbackValue == fallbackDisabledLabel ? "" : transcribeFallbackValue)
        content = setEnvValue(content, "WHISPER_MODEL", whisperModelField.stringValue)
        content = setEnvValue(content, "WHISPER_FALLBACK_MODEL", whisperFallbackModelField.stringValue)
        content = setEnvValue(content, "GEMINI_API_KEY", geminiApiKeyField.stringValue)
        content = setEnvValue(content, "GEMINI_MODEL", geminiModelField.stringValue)
        content = setEnvValue(content, "OPENAI_TRANSCRIBE_API_KEY", openaiTranscribeApiKeyField.stringValue)
        content = setEnvValue(content, "OPENAI_TRANSCRIBE_MODEL", openaiTranscribeModelField.stringValue)
        return content
    }

    @objc func saveSettings() {
        let content = applyFormToEnvContent(readEnvFile())

        do {
            try content.write(toFile: envFilePath, atomically: true, encoding: .utf8)
        } catch {
            appDelegate?.showAlert(title: "Gagal menyimpan", message: error.localizedDescription)
            return
        }

        closeWindow()
        appDelegate?.updateStatus()

        // .env dimuat sekali saat proses start - restart Watch (kalau sedang jalan) supaya
        // perubahan pengaturan langsung aktif, sama seperti saat source code berubah.
        if appDelegate?.isRunning() == true {
            appDelegate?.restartWatcher()
        } else {
            appDelegate?.showNotification(title: "MeetResult", message: "Pengaturan tersimpan.")
        }
    }

    /// Kirim transkrip kecil ke provider/model yang SEDANG diisi di form (lihat `meetresult
    /// test-ai` di cli.js) - supaya bisa dipastikan kerja dengan benar SEBELUM dipakai untuk
    /// notulen meeting asli. Menulis form ke .env dulu (persis seperti Simpan) karena proses
    /// CLI terpisah cuma baca dari file, tapi TIDAK menutup window / restart Watch seperti
    /// Simpan - murni buat tes.
    @objc func testCurrentModel() {
        // Simpan isi .env ASLI dulu sebelum ditimpa buat keperluan tes - dikembalikan lagi
        // di finishTest() supaya klik "Test" tidak meninggalkan perubahan permanen di .env
        // kalau user akhirnya klik "Batal" (bukan "Simpan").
        envSnapshotBeforeTest = readEnvFile()
        envMtimeBeforeTest = (try? fm.attributesOfItem(atPath: envFilePath))?[.modificationDate] as? Date

        let content = applyFormToEnvContent(envSnapshotBeforeTest!)
        do {
            try content.write(toFile: envFilePath, atomically: true, encoding: .utf8)
        } catch {
            envSnapshotBeforeTest = nil
            appDelegate?.showAlert(title: "Gagal menyimpan sebelum tes", message: error.localizedDescription)
            return
        }

        testButton.isEnabled = false
        testButton.title = "Menguji..."

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [nodeBin, cliScript, "test-ai", "--json"]
        task.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        task.environment = subprocessEnvironment()

        let stdoutPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = Pipe() // buang stderr (warning Node dsb) - fokus baris JSON terakhir

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try task.run()
            } catch {
                DispatchQueue.main.async {
                    self?.finishTest()
                    self?.appDelegate?.showAlert(title: "Gagal Menjalankan Tes", message: error.localizedDescription)
                }
                return
            }
            task.waitUntilExit()
            let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                self?.finishTest()
                self?.handleTestResult(output)
            }
        }
    }

    private func finishTest() {
        testButton.isEnabled = true
        testButton.title = "Test"

        // Kembalikan .env ke isi ASLI sebelum tes - "Test" hanya mengecek, tidak mengubah
        // konfigurasi permanen. Kalau user memang mau menyimpan, itu tetap lewat "Simpan".
        if let original = envSnapshotBeforeTest {
            try? original.write(toFile: envFilePath, atomically: true, encoding: .utf8)
            if let mtime = envMtimeBeforeTest {
                try? fm.setAttributes([.modificationDate: mtime], ofItemAtPath: envFilePath)
            }
            envSnapshotBeforeTest = nil
            envMtimeBeforeTest = nil
        }
    }

    private func handleTestResult(_ output: String) {
        let lastLine = output.split(separator: "\n").last.map(String.init) ?? ""
        guard let data = lastLine.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            appDelegate?.showAlert(
                title: "Tes Gagal",
                message: "Tidak bisa membaca hasil tes.\n\n\(output.isEmpty ? "(tidak ada output)" : String(output.prefix(500)))"
            )
            return
        }

        let providerLabel = json["providerLabel"] as? String ?? ""
        let ok = json["ok"] as? Bool ?? false

        if ok {
            let elapsed = json["elapsedSeconds"] as? Double ?? 0
            let markers = (json["markersFound"] as? [String]) ?? []
            let note = markers.isEmpty
                ? "\n\n\u{26A0}\u{FE0F} Respons valid tapi tidak menyebut satupun detail dari transkrip tes - model mungkin mengarang konten, bukan benar-benar membaca transkrip. Waspada untuk meeting asli."
                : "\n\nKonten terverifikasi mengikuti isi transkrip tes."
            appDelegate?.showAlert(
                title: "\u{2705} Provider/Model Siap Dipakai",
                message: "\(providerLabel)\nWaktu respons: \(elapsed) detik.\(note)"
            )
        } else {
            let stage = json["stage"] as? String ?? ""
            let errorMsg = json["error"] as? String ?? ""
            let detail = stage == "placeholder"
                ? "Model mengembalikan teks placeholder mentah dari instruksi, bukan hasil ekstraksi transkrip asli - model ini kemungkinan tidak cukup mampu mengikuti instruksi JSON terstruktur. Coba model lain."
                : (errorMsg.isEmpty ? "Gagal menghubungi provider." : errorMsg)
            appDelegate?.showAlert(title: "\u{274C} Tes Gagal", message: "\(providerLabel)\n\n\(detail)")
        }
    }

    @objc func closeWindow() {
        window?.close()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
