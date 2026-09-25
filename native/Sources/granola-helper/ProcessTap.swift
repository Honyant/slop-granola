import CoreAudio
import Foundation
import HelperCore

/// A global stereo process tap wrapped in a private aggregate device, which is the only way to
/// get an IOProc onto a tap. Destroys both objects on `close()` or deinit.
///
/// The aggregate contains only the tap, no output sub-device. It then has exactly one input
/// stream (the tap's), so the IOProc never has to work out which buffer is which, and nothing
/// in it refers to a particular output device that could disappear.
final class ProcessTap {
    let tapID: AudioObjectID
    let aggregateID: AudioDeviceID
    let format: AudioStreamBasicDescription
    private var isClosed = false

    init(excluding processes: [AudioObjectID]) throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: processes)
        description.uuid = UUID()
        description.name = "granola-helper system audio"
        // Private: invisible to other processes. Unmuted: the user still hears the audio.
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tapID = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")
        do {
            format = try HAL.value(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
            guard format.mFormatID == kAudioFormatLinearPCM,
                  format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
                  format.mBitsPerChannel == 32, format.mSampleRate > 0
            else {
                throw CoreAudioError(status: kAudioHardwareUnsupportedOperationError,
                                     operation: "tap format \(format) is not Float32 PCM")
            }
            let composition: [String: Any] = [
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceNameKey: "granola-helper system audio",
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceTapListKey: [[
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true,
                ]],
            ]
            var aggregateID = AudioDeviceID(kAudioObjectUnknown)
            try check(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregateID),
                      "AudioHardwareCreateAggregateDevice")
            self.aggregateID = aggregateID
        } catch {
            AudioHardwareDestroyProcessTap(tapID)
            throw error
        }
        self.tapID = tapID
    }

    func close() {
        guard !isClosed else { return }
        isClosed = true
        AudioHardwareDestroyAggregateDevice(aggregateID)
        AudioHardwareDestroyProcessTap(tapID)
    }

    deinit { close() }
}

/// Runs an IOProc on a `ProcessTap` and feeds a `StreamEncoder`. Stopping is final.
final class ProcessTapCapture {
    let tap: ProcessTap
    private let writer: FrameWriter
    private let ring: FrameRing
    private var ioProcID: AudioDeviceIOProcID?

    init(tap: ProcessTap, timeline: Timeline, writer: FrameWriter) throws {
        self.tap = tap
        self.writer = writer
        ring = writer.makeRing(source: .system, capacity: streamRingCapacity)
        do {
            let encoder = try StreamEncoder(inputSampleRate: tap.format.mSampleRate, timeline: timeline, ring: ring)
            let bytesPerFrame = Int(tap.format.mBytesPerFrame)
            // Runs on the HAL's real-time IO thread.
            let ioBlock: AudioDeviceIOBlock = { _, input, inputTime, _, _ in
                guard input.pointee.mNumberBuffers > 0 else { return }
                let frames = Int(input.pointee.mBuffers.mDataByteSize) / bytesPerFrame
                let hostTimeValid = inputTime.pointee.mFlags.contains(.hostTimeValid)
                encoder.process(input, frameCount: frames, hostTime: hostTimeValid ? inputTime.pointee.mHostTime : nil)
            }
            try check(AudioDeviceCreateIOProcIDWithBlock(&ioProcID, tap.aggregateID, nil, ioBlock),
                      "AudioDeviceCreateIOProcIDWithBlock")
            try check(AudioDeviceStart(tap.aggregateID, ioProcID), "AudioDeviceStart")
        } catch {
            if let ioProcID { AudioDeviceDestroyIOProcID(tap.aggregateID, ioProcID) }
            writer.retire(ring)
            tap.close()
            throw error
        }
    }

    /// Idempotent. `AudioDeviceStop` returns only once the IOProc is no longer running, so the
    /// ring has no producer left when it is retired.
    func stop() {
        if let ioProcID {
            AudioDeviceStop(tap.aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(tap.aggregateID, ioProcID)
            self.ioProcID = nil
            writer.retire(ring)
        }
        tap.close()
    }
}
