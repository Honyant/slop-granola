import AVFoundation
import CoreAudio
import EventKit

enum PermissionsCommand {
    enum State: String, Encodable {
        case granted, denied, restricted, unknown
        case notDetermined = "not_determined"
    }

    struct Output: Encodable {
        let microphone: State
        let calendar: State
        /// Always `unknown`: macOS has no public API that reads System Audio Recording consent.
        let systemAudio: State
    }

    static func run(_ arguments: [String]) throws -> Output {
        switch arguments {
        case []:
            break
        case ["--request", "microphone"]:
            _ = waitFor { AVCaptureDevice.requestAccess(for: .audio, completionHandler: $0) }
        case ["--request", "calendar"]:
            let store = EKEventStore()
            _ = waitFor { done in store.requestFullAccessToEvents { granted, _ in done(granted) } }
        case ["--request", "system_audio"]:
            try requestSystemAudio()
        default:
            throw CommandError.usage("usage: permissions [--request microphone|calendar|system_audio]")
        }
        return Output(microphone: microphone(), calendar: calendar(), systemAudio: .unknown)
    }

    private static func microphone() -> State {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }

    private static func calendar() -> State {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return .granted
        // Write-only access cannot read events, which is all the helper does with calendars.
        case .writeOnly, .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }

    /// There is no public request API either. Running IO on a process tap makes coreaudiod ask
    /// TCC for System Audio Recording consent, which prompts if the user has not decided yet.
    /// Denied or undecided, the tap still runs and delivers silence, so the outcome is unknowable.
    private static func requestSystemAudio() throws {
        let tap = try ProcessTap(excluding: [])
        defer { tap.close() }
        let firstCycle = DispatchSemaphore(value: 0)
        var createdID: AudioDeviceIOProcID?
        try check(AudioDeviceCreateIOProcIDWithBlock(&createdID, tap.aggregateID, nil) { _, _, _, _, _ in firstCycle.signal() },
                  "AudioDeviceCreateIOProcIDWithBlock")
        guard let ioProcID = createdID else { return }
        defer { AudioDeviceDestroyIOProcID(tap.aggregateID, ioProcID) }
        try check(AudioDeviceStart(tap.aggregateID, ioProcID), "AudioDeviceStart")
        _ = firstCycle.wait(timeout: .now() + 2)
        AudioDeviceStop(tap.aggregateID, ioProcID)
    }
}
