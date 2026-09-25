import AVFoundation
import CoreAudio
import HelperCore

/// Mic stream controller. Main-queue confined.
///
/// Every trigger (start, `set_mic`, default-input change, device list change, engine
/// configuration change, permission answer) calls `reconcile()`, which works out which device
/// should be captured and with what settings, and rebuilds the `MicCapture` only if that differs
/// from what is running. That makes duplicate notifications harmless.
final class MicSource {
    private var config: MicConfig
    private let timeline: Timeline
    private let writer: FrameWriter
    private let report: (HelperEvent) -> Void

    private var capture: MicCapture?
    private var isActive = false
    private var listeners: [PropertyListener] = []
    private var awaitingPermission = false
    /// What the app was last told is capturing; nil before start and after a failure, so that
    /// recovering is announced with `mic_changed`.
    private var announced: MicDescriptor?
    /// False during `start`, whose result goes into the `started` event instead.
    private var announcesChanges = false
    /// The last error reported, so a condition that persists across notifications is reported once.
    private var reportedFailure: String?

    init(config: MicConfig, timeline: Timeline, writer: FrameWriter, report: @escaping (HelperEvent) -> Void) {
        self.config = config
        self.timeline = timeline
        self.writer = writer
        self.report = report
    }

    /// - Returns: the device now capturing, for the `started` event; nil if none (yet).
    func start() -> MicDescriptor? {
        isActive = true
        do {
            listeners = [
                try PropertyListener(HAL.system, kAudioHardwarePropertyDefaultInputDevice) { [weak self] in self?.reconcile() },
                try PropertyListener(HAL.system, kAudioHardwarePropertyDevices) { [weak self] in self?.reconcile() },
            ]
        } catch {
            log("mic: device change notifications unavailable: \(error)")
        }
        reconcile()
        announcesChanges = true
        return announced
    }

    func select(deviceUID: String?) {
        config.deviceUID = deviceUID
        reportedFailure = nil
        reconcile()
    }

    func stop() {
        isActive = false
        listeners = []
        capture?.stop()
        capture = nil
    }

    private func reconcile() {
        guard isActive else { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            guard !awaitingPermission else { return }
            awaitingPermission = true
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { [weak self] in
                    self?.awaitingPermission = false
                    self?.reconcile()
                }
            }
            return
        default:
            return fail(.permissionDenied, "microphone access is not granted")
        }

        let device: InputDevice
        switch target() {
        case let .found(found): device = found
        case let .unavailable(message): return fail(.deviceUnavailable, message)
        }
        let voiceProcessing = config.voiceProcessing && device.id == HAL.defaultInputDevice()
        if let capture, capture.device == device, capture.voiceProcessing == voiceProcessing { return }

        capture?.stop()
        capture = nil
        do {
            capture = try MicCapture(device: device, voiceProcessing: voiceProcessing, timeline: timeline, writer: writer) {
                [weak self] changed in self?.configurationChanged(changed)
            }
        } catch {
            return fail(.deviceUnavailable, "could not capture from \(device.name): \(error)")
        }
        reportedFailure = nil
        let descriptor = capture!.descriptor
        if announcesChanges, descriptor != announced {
            report(.micChanged(descriptor))
        }
        announced = descriptor
    }

    private func configurationChanged(_ changed: MicCapture) {
        guard changed === capture else { return }
        log("mic: engine configuration changed, restarting")
        capture?.stop()
        capture = nil
        reconcile()
    }

    private enum Target { case found(InputDevice), unavailable(String) }

    private func target() -> Target {
        if let uid = config.deviceUID {
            guard let id = HAL.device(uid: uid), HAL.hasInput(id), let device = InputDevice(id) else {
                return .unavailable("input device \(uid) is not available")
            }
            return .found(device)
        }
        guard let id = HAL.defaultInputDevice(), let device = InputDevice(id) else {
            return .unavailable("there is no default input device")
        }
        return .found(device)
    }

    private func fail(_ code: ErrorCode, _ message: String) {
        capture?.stop()
        capture = nil
        announced = nil
        guard message != reportedFailure else { return }
        reportedFailure = message
        report(.error(source: .mic, code: code, message: message))
    }
}
