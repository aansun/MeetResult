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
let logFile = dataDir + "/watcher.log"
let summariesDir = dataDir + "/summaries"
let recordingStateFile = dataDir + "/recording-state.json"
let dbFile = dataDir + "/db.json"
let manualLogFile = dataDir + "/manual-record.log"
let nodeBin = "node"
let cliScript = "bin/meetresult.js"

func statusIcon(_ status: String) -> String {
    switch status {
    case "scheduled": return "\u{1F5D3}\u{FE0F}"   // 🗓️
    case "recording": return "\u{1F534}"           // 🔴
    case "processing", "transcribed", "recorded": return "\u{23F3}" // ⏳
    case "done": return "\u{2705}"                 // ✅
    case "error": return "\u{26A0}\u{FE0F}"        // ⚠️
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

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!

    // Submenu Watch
    var watchStatusItem: NSMenuItem!
    var startItem: NSMenuItem!
    var stopItem: NSMenuItem!

    // Submenu Rekam Manual
    var manualStatusMenuItem: NSMenuItem!
    var recordManualItem: NSMenuItem!
    var stopManualItem: NSMenuItem!

    // Submenu Event List
    var eventListMenu: NSMenu!

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

        let checkUpdate = NSMenuItem(title: "Cek Update...", action: #selector(checkForUpdate), keyEquivalent: "u")
        checkUpdate.target = self
        menu.addItem(checkUpdate)

        menu.addItem(NSMenuItem.separator())

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

    func isRunning() -> Bool {
        guard let pidStr = try? String(contentsOfFile: pidFile, encoding: .utf8) else { return false }
        let trimmed = pidStr.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let pid = Int32(trimmed), pid > 0 else { return false }
        return kill(pid, 0) == 0
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

    func updateStatus() {
        let running = isRunning()
        let recordingActive = isAnyRecordingActive()
        let activeId = activeRecordingMeetingId()
        let isAutoTriggered = recordingActive && !(activeId?.hasPrefix("manual-") ?? false)

        let attrTitle = NSMutableAttributedString()
        let dotColor: NSColor = (running || recordingActive) ? .systemGreen : .systemGray
        attrTitle.append(NSAttributedString(
            string: "\u{25CF} ", // ●
            attributes: [.foregroundColor: dotColor]
        ))
        attrTitle.append(NSAttributedString(
            string: "MR",
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.menuBarFont(ofSize: 13)
            ]
        ))
        statusItem.button?.attributedTitle = attrTitle

        watchStatusItem.title = running ? "Status: Berjalan \u{2705}" : "Status: Berhenti \u{26D4}\u{FE0F}"
        startItem.isEnabled = !running
        stopItem.isEnabled = running

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

        var env = ProcessInfo.processInfo.environment
        let extraPaths = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/Library/Python/3.9/bin"
        env["PATH"] = extraPaths + ":" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        task.environment = env

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

        if let pidStr = try? String(contentsOfFile: pidFile, encoding: .utf8),
           let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
            kill(pid, SIGTERM)
            try? fm.removeItem(atPath: pidFile)
        }

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

    @objc func checkForUpdate() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [nodeBin, cliScript, "update"]
        task.currentDirectoryURL = URL(fileURLWithPath: projectDir)

        var env = ProcessInfo.processInfo.environment
        let extraPaths = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/Library/Python/3.9/bin"
        env["PATH"] = extraPaths + ":" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        task.environment = env

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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
