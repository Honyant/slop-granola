import AudioToolbox

/// The real-time half of one capture stream: downmix, resample, timestamp, and publish frames
/// into the stream's ring. Runs on the stream's audio callback thread and nowhere else.
public final class StreamEncoder {
    /// Host-time measurements within this many samples (5 ms) of the running count are treated
    /// as jitter; see `ChunkStamper`.
    public static let continuityToleranceSamples: Int64 = 80

    public let ring: FrameRing
    private let timeline: Timeline
    private let resampler: MonoResampler
    private var stamper: ChunkStamper
    /// Timeline samples per input frame, for positioning sub-chunks of a long buffer.
    private let positionPerFrame: Double

    /// - Parameter maxChunkFrames: longer buffers are fed to the resampler in pieces. The
    ///   AudioToolbox converter processes at most 4096 input frames per call and buffers the rest
    ///   until the next call, so larger pieces would add up to a whole buffer of latency.
    public init(inputSampleRate: Double, timeline: Timeline, ring: FrameRing, maxChunkFrames: Int = 4096) throws {
        self.ring = ring
        self.timeline = timeline
        resampler = try MonoResampler(inputSampleRate: inputSampleRate, maxInputFrames: maxChunkFrames)
        stamper = ChunkStamper(inputSampleRate: inputSampleRate, toleranceSamples: Self.continuityToleranceSamples)
        positionPerFrame = Double(Timeline.sampleRate) / inputSampleRate
    }

    /// - Parameter hostTime: `mHostTime` of the buffer's first frame, or nil if not valid.
    public func process(_ input: UnsafePointer<AudioBufferList>, frameCount: Int, hostTime: UInt64?) {
        var start = 0
        while start < frameCount {
            let count = min(resampler.maxInputFrames, frameCount - start)
            var position: Double?
            if let hostTime {
                position = timeline.position(ofHostTime: hostTime) + Double(start) * positionPerFrame
            }
            let samples = resampler.process(input, startFrame: start, frameCount: count)
            let index = stamper.place(inputFrames: count, inputPosition: position, outputSamples: samples.count)
            publish(samples, at: index)
            start += count
        }
    }

    /// The timeline starts at 0, so samples stamped before it (possible only for audio captured
    /// in the instant before `start` was processed) are trimmed.
    private func publish(_ samples: UnsafeBufferPointer<Int16>, at index: Int64) {
        let skip = Int(max(0, -index))
        guard skip < samples.count else { return }
        ring.pushAudio(sampleIndex: UInt64(index + Int64(skip)),
                       samples: UnsafeBufferPointer(rebasing: samples[skip...]))
    }
}
