import AudioToolbox
import XCTest
@testable import HelperCore

/// End-to-end timing: sample_index of resampled output must place events where they happened.
final class StreamEncoderTests: XCTestCase {
    private let origin: UInt64 = 1_000_000_000
    private let nanoseconds = HostTimebase(numer: 1, denom: 1)

    /// Smooth Gaussian pulses, band-limited well below 8 kHz so they survive resampling intact.
    private let pulseTimes = [0.1, 0.5, 1.3, 1.9]
    private func pulses(at time: Double) -> Float {
        Float(pulseTimes.reduce(0.0) { $0 + 0.8 * exp(-pow((time - $1) / 0.0005, 2)) })
    }

    /// Feeds `signal` in `bufferFrames` buffers with exact host times, starting `startOffset`
    /// seconds after the timeline origin, and returns the timeline the frames describe.
    /// `stall` delays the host time of every buffer from `at` seconds of input onward by `by`
    /// seconds, as if the device had stopped delivering for that long.
    private func encode(
        _ signal: inout Interleaved,
        bufferFrames: Int,
        startOffset: Double = 0,
        stall: (at: Double, by: Double)? = nil
    ) throws -> [Int16] {
        let ring = FrameRing(source: .system, capacity: 1 << 20)
        let encoder = try StreamEncoder(
            inputSampleRate: signal.sampleRate,
            timeline: Timeline(originHostTime: origin, timebase: nanoseconds),
            ring: ring)
        let frames = signal.frameCount
        let rate = signal.sampleRate
        let origin = self.origin
        signal.withBufferList { list in
            for start in stride(from: 0, to: frames, by: bufferFrames) {
                // Offset a copy of the list so each call sees its own buffer, as in a real callback.
                var buffer = list.pointee.mBuffers
                buffer.mData = buffer.mData! + start * Int(buffer.mNumberChannels) * MemoryLayout<Float>.size
                var sub = AudioBufferList(mNumberBuffers: 1, mBuffers: buffer)
                let inputTime = Double(start) / rate
                let delay = stall.map { inputTime >= $0.at ? $0.by : 0 } ?? 0
                let host = Int64(origin) + Int64(((startOffset + inputTime + delay) * 1e9).rounded())
                encoder.process(&sub, frameCount: min(bufferFrames, frames - start), hostTime: UInt64(host))
            }
        }
        var timeline: [Int16] = []
        var nextIndex: UInt64?
        for frame in try peekFrames(ring) {
            guard case let .audio(source, index, samples) = frame else {
                XCTFail("unexpected frame \(frame)")
                return []
            }
            XCTAssertEqual(source, AudioSource.system.rawValue)
            if let nextIndex, stall == nil { XCTAssertEqual(index, nextIndex, "chunks should be contiguous") }
            if timeline.count < Int(index) { timeline += repeatElement(0, count: Int(index) - timeline.count) }
            timeline.replaceSubrange(Int(index)..<min(timeline.count, Int(index) + samples.count), with: [])
            timeline.insert(contentsOf: samples, at: Int(index))
            nextIndex = index + UInt64(samples.count)
        }
        return timeline
    }

    /// Sub-sample peak position of the pulse nearest `expected`, by parabolic interpolation.
    private func peak(in timeline: [Int16], near expected: Double) -> Double {
        let window = Int(expected) - 40...Int(expected) + 40
        let i = window.max { timeline[$0] < timeline[$1] }!
        let (a, b, c) = (Double(timeline[i - 1]), Double(timeline[i]), Double(timeline[i + 1]))
        return Double(i) + 0.5 * (a - c) / (a - 2 * b + c)
    }

    private func assertPulsesAligned(
        _ timeline: [Int16],
        offset: Double = 0,
        stall: (at: Double, by: Double)? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for t in pulseTimes {
            let delay = stall.map { t >= $0.at ? $0.by : 0 } ?? 0
            let expected = (t + offset + delay) * 16_000
            XCTAssertEqual(peak(in: timeline, near: expected), expected, accuracy: 0.5, "pulse at \(t) s", file: file, line: line)
        }
    }

    func testPulsesLandOnTheirCaptureTimeWithSmallIOBuffers() throws {
        var signal = Interleaved(sampleRate: 48_000, channels: 2, frames: 96_000) { t, _ in pulses(at: t) }
        assertPulsesAligned(try encode(&signal, bufferFrames: 512))
    }

    func testLargeBuffersAreSplitWithoutShiftingTime() throws {
        // 4800-frame AVAudioEngine tap buffers exceed the encoder's 4096-frame chunk.
        var signal = Interleaved(sampleRate: 48_000, channels: 1, frames: 96_000) { t, _ in pulses(at: t) }
        assertPulsesAligned(try encode(&signal, bufferFrames: 4_800))
    }

    func testNon48kDeviceStartingLate() throws {
        var signal = Interleaved(sampleRate: 44_100, channels: 2, frames: 88_200) { t, _ in pulses(at: t) }
        assertPulsesAligned(try encode(&signal, bufferFrames: 441, startOffset: 0.25), offset: 0.25)
    }

    /// After a stall the stream re-anchors on host time. This is where the resampler backlog
    /// matters: without it the post-stall pulses would land ~0.7 ms late.
    func testStallReanchorsOnHostTimeAccountingForResamplerBacklog() throws {
        var signal = Interleaved(sampleRate: 48_000, channels: 2, frames: 96_000) { t, _ in pulses(at: t) }
        let stall = (at: 1.0, by: 0.5)
        assertPulsesAligned(try encode(&signal, bufferFrames: 480, stall: stall), stall: stall)
    }

    func testAudioStampedBeforeOriginIsTrimmed() throws {
        let ring = FrameRing(source: .mic, capacity: 1 << 16)
        let encoder = try StreamEncoder(inputSampleRate: 16_000, timeline: Timeline(originHostTime: origin, timebase: nanoseconds), ring: ring)
        var signal = Interleaved(sampleRate: 16_000, channels: 1, frames: 1_600) { _, _ in 0.5 }
        signal.withBufferList { encoder.process($0, frameCount: 1_600, hostTime: origin - 50_000_000) }  // 50 ms early
        let frames = try peekFrames(ring)
        guard case let .audio(_, index, samples)? = frames.first else { return XCTFail("no audio") }
        XCTAssertEqual(index, 0)
        XCTAssertLessThanOrEqual(samples.count, 800)
    }
}
