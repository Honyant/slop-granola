import CoreAudio
import Darwin
import HelperCore

/// System-audio stream controller. Main-queue confined.
///
/// Keeps a `ProcessTapCapture` running for the whole session: rebuilds it when the default
/// output device or the tap's format changes, and keeps the app's own processes excluded as
/// they come and go.
final class SystemAudioSource {
    private let timeline: Timeline
    private let writer: FrameWriter
    private let report: (HelperEvent) -> Void
    private var capture: ProcessTapCapture?
    /// Between `start` and `stop`; a failed rebuild is retried on the next device change.
    private var isActive = false
    private var excluded: [AudioObjectID] = []
    private var listeners: [PropertyListener] = []
    private var tapFormatListener: PropertyListener?

    init(timeline: Timeline, writer: FrameWriter, report: @escaping (HelperEvent) -> Void) {
        self.timeline = timeline
        self.writer = writer
        self.report = report
    }

    func start() throws {
        excluded = Self.appProcessObjects()
        isActive = true
        do {
            try build()
            listeners = [
                try PropertyListener(HAL.system, kAudioHardwarePropertyDefaultOutputDevice) { [weak self] in
                    self?.rebuild(reason: "default output device changed")
                },
                try PropertyListener(HAL.system, kAudioHardwarePropertyProcessObjectList) { [weak self] in
                    self?.refreshExclusions()
                },
            ]
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        isActive = false
        listeners = []
        tapFormatListener = nil
        capture?.stop()
        capture = nil
    }

    private func build() throws {
        let capture = try ProcessTapCapture(tap: ProcessTap(excluding: excluded), timeline: timeline, writer: writer)
        do {
            tapFormatListener = try PropertyListener(capture.tap.tapID, kAudioTapPropertyFormat) { [weak self] in
                self?.rebuild(reason: "tap format changed")
            }
        } catch {
            capture.stop()
            throw error
        }
        self.capture = capture
    }

    /// The new stream re-anchors on host time, so the consumer sees a short gap, not a shift.
    private func rebuild(reason: String) {
        guard isActive else { return }
        log("system audio: rebuilding tap (\(reason))")
        tapFormatListener = nil
        capture?.stop()
        capture = nil
        do {
            try build()
        } catch {
            report(.error(source: .system, code: .deviceUnavailable, message: "system audio capture stopped: \(error)"))
        }
    }

    /// Updating a running tap's description fails with kAudioDevicePermissionsError, so a
    /// changed exclusion list means a new tap. Only the app's own processes starting or
    /// stopping audio change the list.
    private func refreshExclusions() {
        let current = Self.appProcessObjects()
        guard current != excluded else { return }
        excluded = current
        rebuild(reason: "the app's audio processes changed")
    }

    /// Audio objects of this process, its parent (the app) and the parent's other children.
    ///
    /// Siblings matter because Electron does not play audio from its main process: Chromium's
    /// audio service runs in a utility process that is another child of the main process.
    /// When the parent is launchd (orphaned, or started by launchd directly) its "children" are
    /// every app on the system, so only this process is excluded.
    static func appProcessObjects() -> [AudioObjectID] {
        let me = getpid()
        let app = getppid()
        let objects = (try? HAL.processObjects()) ?? []
        return objects.filter { object in
            guard let pid = HAL.pid(ofProcessObject: object) else { return false }
            if pid == me { return true }
            guard app > 1 else { return false }
            return pid == app || parentPID(of: pid) == app
        }.sorted()
    }

}
