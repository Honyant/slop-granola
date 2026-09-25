import AVFoundation
import CoreAudio
import HelperCore

struct InputDevice: Equatable {
    let id: AudioDeviceID
    let uid: String
    let name: String

    init?(_ id: AudioDeviceID) {
        guard let uid = try? HAL.string(id, kAudioDevicePropertyDeviceUID),
              let name = try? HAL.string(id, kAudioObjectPropertyName)
        else { return nil }
        self.id = id
        self.uid = uid
        self.name = name
    }
}

/// One AVAudioEngine capturing one input device into its own ring. Stopping is final; a device
/// or configuration change means building a new instance.
///
/// A fresh engine per configuration costs a few milliseconds and rules out every class of
/// stale-state bug from reconfiguring a running engine (the input node's cached formats in
/// particular go stale when its device changes).
final class MicCapture {
    let device: InputDevice
    let voiceProcessing: Bool
    private let engine = AVAudioEngine()
    private let writer: FrameWriter
    private let ring: FrameRing
    private var configurationObserver: NSObjectProtocol?
    private var isStopped = false

    /// - Parameter voiceProcessing: only valid when `device` is the system default input:
    ///   voice processing ignores the unit's device selection and uses the default input.
    /// - Parameter onConfigurationChange: called on the main queue when the engine has stopped
    ///   itself because the device's format or availability changed.
    init(
        device: InputDevice,
        voiceProcessing: Bool,
        timeline: Timeline,
        writer: FrameWriter,
        onConfigurationChange: @escaping (MicCapture) -> Void
    ) throws {
        self.device = device
        self.voiceProcessing = voiceProcessing
        self.writer = writer
        let input = engine.inputNode
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
            // By default voice processing ducks all other audio output, which would turn down
            // the meeting the user is listening to.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                .init(enableAdvancedDucking: false, duckingLevel: .min)
        } else {
            var id = device.id
            try check(AudioUnitSetProperty(input.audioUnit!, kAudioOutputUnitProperty_CurrentDevice,
                                           kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)),
                      "select input device \(device.uid)")
        }
        // The hardware-side format: the output-side one still describes the previous device.
        let format = input.inputFormat(forBus: 0)
        guard format.commonFormat == .pcmFormatFloat32, format.sampleRate > 0, format.channelCount > 0 else {
            throw CoreAudioError(status: kAudioHardwareUnsupportedOperationError, operation: "input format \(format)")
        }

        ring = writer.makeRing(source: .mic, capacity: streamRingCapacity)
        do {
            let encoder = try StreamEncoder(inputSampleRate: format.sampleRate, timeline: timeline, ring: ring)
            // AVAudioEngine delivers ~100 ms per tap callback on macOS whatever size is asked for.
            // The block runs on an engine-owned high-priority thread, not the IO thread, but is
            // held to the same no-blocking rules.
            input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { buffer, time in
                encoder.process(buffer.audioBufferList, frameCount: Int(buffer.frameLength),
                                hostTime: time.isHostTimeValid ? time.hostTime : nil)
            }
            // Selecting a device posts one notification although the engine keeps running, so
            // only a notification that finds the engine stopped means it needs rebuilding.
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in
                guard let self, !self.engine.isRunning else { return }
                onConfigurationChange(self)
            }
            engine.prepare()
            try engine.start()
        } catch {
            stop()
            throw error
        }
    }

    var descriptor: MicDescriptor {
        MicDescriptor(uid: device.uid, name: device.name, voiceProcessing: voiceProcessing)
    }

    /// Idempotent. A tap block already queued when the engine stops may still run afterwards;
    /// it can only push into this (retired) ring, which is harmless.
    func stop() {
        guard !isStopped else { return }
        isStopped = true
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        writer.retire(ring)
    }
}
