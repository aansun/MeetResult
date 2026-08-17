import Cocoa

// MeetResultTray — Menu bar indicator untuk aplikasi MeetResult
// Icon: "MR" dengan titik status (hijau = berjalan, abu-abu = berhenti)
// Menu: Start/Stop Watch (mode otomatis via kalender), Rekam Manual/Stop (di luar kalender),
//       Buka Folder Notulen, Lihat Log, Keluar

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
let manualLogFile = dataDir + "/manual-record.log"
let nodeBin = "node"
let cliScript = "bin/meetresult.js"

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var manualStatusMenuItem: NSMenuItem!
    var startItem: NSMenuItem!
    var stopItem: NSMenuItem!
    var recordManualItem: NSMenuItem!
    var stopManualItem: NSMenuItem!
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

        // --- Status watcher (mode otomatis via kalender) ---
        statusMenuItem = NSMenuItem(title: "Status Watch: Mengecek...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem.separator())

        startItem = NSMenuItem(title: "Start MeetResult (Watch)", action: #selector(startWatcher), keyEquivalent: "s")
        startItem.target = self
        menu.addItem(startItem)

        stopItem = NSMenuItem(title: "Stop MeetResult", action: #selector(stopWatcher), keyEquivalent: "t")
        stopItem.target = self
        menu.addItem(stopItem)

        menu.addItem(NSMenuItem.separator())

        // --- Rekam manual (di luar kalender) ---
        manualStatusMenuItem = NSMenuItem(title: "Rekam Manual: Mengecek...", action: nil, keyEquivalent: "")
        manualStatusMenuItem.isEnabled = false
        menu.addItem(manualStatusMenuItem)

        recordManualItem = NSMenuItem(title: "Rekam Manual (di luar kalender)...", action: #selector(startManualRecording), keyEquivalent: "r")
        recordManualItem.target = self
        menu.addItem(recordManualItem)

        stopManualItem = NSMenuItem(title: "Stop & Proses Notulen", action: #selector(stopManualRecording), keyEquivalent: "x")
        stopManualItem.target = self
        menu.addItem(stopManualItem)

        menu.addItem(NSMenuItem.separator())

        let openSummary = NSMenuItem(title: "Buka Folder Notulen (MoM)", action: #selector(openSummaryFolder), keyEquivalent: "o")
        openSummary.target = self
        menu.addItem(openSummary)

        let openLog = NSMenuItem(title: "Lihat Log Aktivitas", action: #selector(openLogFile), keyEquivalent: "l")
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

        statusMenuItem.title = running ? "Status Watch: Berjalan \u{2705}" : "Status Watch: Berhenti \u{26D4}\u{FE0F}"
        startItem.isEnabled = !running
        stopItem.isEnabled = running

        // Rekaman manual HARUS nonaktif kalau sedang ada rekaman aktif dari sumber manapun
        // (termasuk yang dipicu otomatis oleh watcher/kalender) - hanya 1 rekaman boleh berjalan.
        if isAutoTriggered {
            manualStatusMenuItem.title = "Rekam Manual: Nonaktif (watcher sedang merekam meeting kalender) \u{1F512}"
        } else if recordingActive {
            manualStatusMenuItem.title = "Rekam Manual: Sedang Merekam \u{1F534}"
        } else {
            manualStatusMenuItem.title = "Rekam Manual: Tidak Aktif"
        }
        recordManualItem.isEnabled = !recordingActive
        stopManualItem.isEnabled = recordingActive
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

    @objc func stopWatcher() {
        guard let pidStr = try? String(contentsOfFile: pidFile, encoding: .utf8),
              let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            updateStatus()
            return
        }
        kill(pid, SIGTERM)
        try? fm.removeItem(atPath: pidFile)
        updateStatus()
    }

    // MARK: - Rekam manual (di luar kalender)

    @objc func startManualRecording() {
        if isAnyRecordingActive() {
            let autoTriggered = !(activeRecordingMeetingId()?.hasPrefix("manual-") ?? false)
            showAlert(
                title: "Tidak Bisa Mulai Rekam Manual",
                message: autoTriggered
                    ? "Watcher sedang merekam meeting dari kalender. Hentikan dulu ('Stop MeetResult' atau tunggu selesai) sebelum mulai rekam manual - hanya 1 rekaman yang boleh berjalan bersamaan."
                    : "Sudah ada rekaman manual yang sedang berjalan. Hentikan dulu lewat 'Stop & Proses Notulen'."
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
            showAlert(title: "Cek Update Gagal", message: error.localizedDescription)
            return
        }

        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        var output = String(data: data, encoding: .utf8) ?? ""
        // Bersihkan warning teknis Node.js yang tidak relevan buat user
        output = output
            .components(separatedBy: "\n")
            .filter { !$0.contains("ExperimentalWarning") && !$0.contains("trace-warnings") }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        showAlert(title: "Cek Update MeetResult", message: output.isEmpty ? "Tidak ada output." : output)
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
