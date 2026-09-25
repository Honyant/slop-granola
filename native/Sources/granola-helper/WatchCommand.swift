import AppKit
import CoreAudio
import Foundation

/// `granola-helper watch`: reports which apps are using a microphone, as JSON lines on
/// stdout, whenever that set changes. The app uses it to notice that a meeting started
/// (Zoom, a browser tab in Meet, FaceTime...) and offer to take notes.
///
/// Polling rather than HAL listeners: listening needs one registration per process object
/// (they come and go) plus one on the process list, and a 1 Hz poll of a few property reads
/// costs microseconds while a meeting lasts minutes, so nothing is missed.
enum WatchCommand {
    struct App: Encodable, Equatable {
        let pid: Int32
        let name: String
        let bundleId: String?
    }

    struct Event: Encodable {
        let event = "mic_apps"
        let apps: [App]
    }

    static let pollInterval: DispatchTimeInterval = .seconds(1)

    static func run() -> Never {
        var last: [App]? = nil
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: pollInterval)
        timer.setEventHandler {
            let current = micApps()
            guard current != last else { return }
            last = current
            emit(Event(apps: current))
        }
        timer.resume()

        // stdin EOF means the parent is gone; the watcher must not outlive it.
        Thread.detachNewThread {
            while readLine() != nil {}
            exit(0)
        }
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { exit(0) }
            source.resume()
            signalSources.append(source)
        }
        dispatchMain()
    }

    private static var signalSources: [DispatchSourceSignal] = []

    /// Apps with at least one process currently capturing audio input, excluding this app.
    static func micApps() -> [App] {
        let own = Set(SystemAudioSource.appProcessObjects())
        var apps: [Int32: App] = [:]
        for object in (try? HAL.processObjects()) ?? [] where !own.contains(object) {
            guard let running: UInt32 = try? HAL.value(object, kAudioProcessPropertyIsRunningInput, initial: 0),
                  running != 0,
                  let pid = HAL.pid(ofProcessObject: object),
                  let app = owningApp(of: pid)
            else { continue }
            apps[app.pid] = app
        }
        return apps.values.sorted { $0.pid < $1.pid }
    }

    /// Browsers and Electron apps capture from helper processes ("Arc Helper (Renderer)");
    /// users know the app, so walk up the parent chain to the first regular (Dock) app.
    /// Anything without one is a background service, e.g. CoreSpeech holds the mic for
    /// "Hey Siri" permanently, and is never a meeting.
    private static func owningApp(of pid: pid_t) -> App? {
        var current = pid
        for _ in 0..<8 {
            if let app = NSRunningApplication(processIdentifier: current), app.activationPolicy == .regular {
                return App(pid: current, name: app.localizedName ?? app.bundleIdentifier ?? "An app", bundleId: app.bundleIdentifier)
            }
            guard let parent = parentPID(of: current), parent > 1 else { return nil }
            current = parent
        }
        return nil
    }

    private static func emit(_ event: Event) {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard var data = try? encoder.encode(event) else { return }
        data.append(UInt8(ascii: "\n"))
        FileHandle.standardOutput.write(data)
    }
}
