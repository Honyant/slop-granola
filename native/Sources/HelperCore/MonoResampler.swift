import AudioToolbox

public struct AudioConverterError: Error, CustomStringConvertible {
    public let status: OSStatus
    public let operation: String
    public var description: String { "\(operation) failed (OSStatus \(status))" }
}

/// Downmixes Float32 audio of any channel count and layout to mono, then resamples it to
/// 16 kHz s16 with an AudioToolbox sample-rate converter.
///
/// Every buffer is allocated up front; `process` allocates nothing and takes no locks, so it
/// can run on a Core Audio IO thread. Not thread-safe: one instance belongs to one stream.
///
/// The C `AudioConverter` API is used instead of `AVAudioConverter` because the latter's input
/// block is a Swift closure bridged to an Objective-C block on every call; the C API takes a
/// function pointer and a context pointer, so nothing is allocated per buffer.
public final class MonoResampler {
    public let inputSampleRate: Double
    /// Largest number of input frames one `process` call accepts.
    public let maxInputFrames: Int

    private let converter: AudioConverterRef
    private let mono: UnsafeMutablePointer<Float>
    private let output: UnsafeMutablePointer<Int16>
    private let outputCapacity: Int
    private let pending: UnsafeMutablePointer<PendingInput>

    public init(inputSampleRate: Double, maxInputFrames: Int) throws {
        precondition(inputSampleRate > 0 && maxInputFrames > 0)
        self.inputSampleRate = inputSampleRate
        self.maxInputFrames = maxInputFrames

        var inputFormat = AudioStreamBasicDescription(
            mSampleRate: inputSampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var outputFormat = AudioStreamBasicDescription(
            mSampleRate: Double(Timeline.sampleRate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
            mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)

        var converter: AudioConverterRef?
        let status = AudioConverterNew(&inputFormat, &outputFormat, &converter)
        guard status == noErr, let converter else {
            throw AudioConverterError(status: status, operation: "AudioConverterNew")
        }
        self.converter = converter

        var quality = kAudioConverterQuality_High
        AudioConverterSetProperty(converter, kAudioConverterSampleRateConverterQuality,
                                  UInt32(MemoryLayout.size(ofValue: quality)), &quality)

        mono = .allocate(capacity: maxInputFrames)
        // Output per call can exceed frames * ratio by the few samples the converter held back
        // on the previous call.
        outputCapacity = Int((Double(maxInputFrames) * Double(Timeline.sampleRate) / inputSampleRate).rounded(.up)) + 64
        output = .allocate(capacity: outputCapacity)
        pending = .allocate(capacity: 1)
        pending.initialize(to: PendingInput(samples: mono, frames: 0))
    }

    deinit {
        AudioConverterDispose(converter)
        mono.deallocate()
        output.deallocate()
        pending.deallocate()
    }

    /// Converts `frameCount` frames starting at frame `startFrame` of `input` (Float32, any
    /// number of buffers, each interleaved with its own channel count).
    ///
    /// - Returns: 16 kHz mono samples, valid until the next call.
    public func process(
        _ input: UnsafePointer<AudioBufferList>,
        startFrame: Int,
        frameCount: Int
    ) -> UnsafeBufferPointer<Int16> {
        precondition(frameCount <= maxInputFrames)
        downmix(input, startFrame: startFrame, frameCount: frameCount)
        pending.pointee.frames = UInt32(frameCount)

        var outputList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 1,
                                  mDataByteSize: UInt32(outputCapacity * MemoryLayout<Int16>.size),
                                  mData: UnsafeMutableRawPointer(output)))
        var outputPackets = UInt32(outputCapacity)
        // Returns `inputExhausted` once the pending buffer has been handed over. The converter
        // then returns whatever it could produce and keeps its filter state for the next call.
        _ = AudioConverterFillComplexBuffer(converter, supplyPendingInput, pending, &outputPackets, &outputList, nil)
        return UnsafeBufferPointer(start: output, count: Int(outputPackets))
    }

    /// Averages all channels. Averaging (rather than summing) keeps a centred source such as
    /// a voice at its original level and cannot clip.
    private func downmix(_ input: UnsafePointer<AudioBufferList>, startFrame: Int, frameCount: Int) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        mono.update(repeating: 0, count: frameCount)
        var totalChannels = 0
        for buffer in buffers {
            guard let data = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
            let channels = Int(buffer.mNumberChannels)
            totalChannels += channels
            for channel in 0..<channels {
                var sample = data + startFrame * channels + channel
                for frame in 0..<frameCount {
                    mono[frame] += sample.pointee
                    sample += channels
                }
            }
        }
        guard totalChannels > 1 else { return }
        let scale = 1 / Float(totalChannels)
        for frame in 0..<frameCount { mono[frame] *= scale }
    }
}

/// The mono input handed to the converter's input callback for the current call.
private struct PendingInput {
    var samples: UnsafeMutablePointer<Float>
    var frames: UInt32
}

/// Status the input callback returns when it has nothing more for this call. Any non-zero
/// value works; the converter passes it back from `AudioConverterFillComplexBuffer`.
private let inputExhausted: OSStatus = 1

private let supplyPendingInput: AudioConverterComplexInputDataProc = { _, packetCount, bufferList, _, context in
    let pending = context!.assumingMemoryBound(to: PendingInput.self)
    guard pending.pointee.frames > 0 else {
        packetCount.pointee = 0
        return inputExhausted
    }
    bufferList.pointee.mNumberBuffers = 1
    bufferList.pointee.mBuffers = AudioBuffer(
        mNumberChannels: 1,
        mDataByteSize: pending.pointee.frames * UInt32(MemoryLayout<Float>.size),
        mData: UnsafeMutableRawPointer(pending.pointee.samples))
    packetCount.pointee = pending.pointee.frames
    pending.pointee.frames = 0
    return noErr
}
