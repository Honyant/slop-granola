/// Assigns a timeline `sample_index` to each chunk of resampler output.
///
/// The host time of an input buffer tells us where that buffer's *first input frame* sits on
/// the timeline, but the resampler's output lags its input: some input it has consumed is still
/// in its filter history and has not been emitted yet. Output sample `k` (counting from when the
/// resampler was created) corresponds to input frame `k / ratio`, so the first output sample of
/// a call sits `backlog = inputConsumed * ratio - outputEmitted` output samples before the new
/// buffer's first frame.
///
/// Consecutive chunks are kept contiguous while the host-time measurement agrees with the
/// running sample count to within `tolerance` samples. Beyond that (a stall, dropped IO cycles,
/// or accumulated device-vs-host clock drift) the stream re-anchors on the measurement and the
/// consumer sees a gap or an overlap, as the protocol allows.
public struct ChunkStamper {
    /// Output samples per input frame.
    private let ratio: Double
    private let tolerance: Int64
    private var inputConsumed: Int64 = 0
    private var outputEmitted: Int64 = 0
    /// Where the previous chunk ended; nil before the first chunk.
    private var nextIndex: Int64?

    public init(inputSampleRate: Double, toleranceSamples: Int64) {
        ratio = Double(Timeline.sampleRate) / inputSampleRate
        tolerance = toleranceSamples
    }

    /// Accounts for one resampler call and returns the timeline index of its first output sample.
    ///
    /// - Parameters:
    ///   - inputFrames: frames fed to the resampler in this call.
    ///   - inputPosition: timeline position of the first of those frames, or nil if the buffer
    ///     had no valid host time (the chunk then continues the previous one).
    ///   - outputSamples: samples the resampler produced in this call.
    public mutating func place(inputFrames: Int, inputPosition: Double?, outputSamples: Int) -> Int64 {
        let backlog = Double(inputConsumed) * ratio - Double(outputEmitted)
        let measured = inputPosition.map { ($0 - backlog).rounded() }
        inputConsumed += Int64(inputFrames)
        outputEmitted += Int64(outputSamples)

        let index: Int64
        switch (nextIndex, measured) {
        case let (expected?, measured?):
            index = abs(Int64(measured) - expected) <= tolerance ? expected : Int64(measured)
        case let (expected?, nil):
            index = expected
        case let (nil, measured?):
            index = Int64(measured)
        case (nil, nil):
            index = 0
        }
        nextIndex = index + Int64(outputSamples)
        return index
    }
}
