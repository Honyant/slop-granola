import AudioToolbox
import XCTest
@testable import HelperCore

final class MonoResamplerTests: XCTestCase {
    private let fullScale = Double(Int16.max)

    /// Runs `signal` through a resampler in `chunk`-frame pieces and concatenates the output.
    private func resample(_ signal: inout Interleaved, chunk: Int) throws -> [Int16] {
        let resampler = try MonoResampler(inputSampleRate: signal.sampleRate, maxInputFrames: chunk)
        var output: [Int16] = []
        let frames = signal.frameCount
        signal.withBufferList { list in
            for start in stride(from: 0, to: frames, by: chunk) {
                output += resampler.process(list, startFrame: start, frameCount: min(chunk, frames - start))
            }
        }
        return output
    }

    func testStereo48kSineBecomes16kMonoSineOfSameFrequencyAndAmplitude() throws {
        var signal = Interleaved(sampleRate: 48_000, channels: 2, frames: 96_000) { t, _ in sine(440, amplitude: 0.5, at: t) }
        let output = try resample(&signal, chunk: 512)
        XCTAssertEqual(Double(output.count), 32_000, accuracy: 64)
        let steady = output[1_000..<31_000]
        XCTAssertEqual(dominantFrequency(steady, sampleRate: 16_000, around: 440), 440, accuracy: 0.2)
        XCTAssertEqual(rms(steady) * 2.squareRoot() / fullScale, 0.5, accuracy: 0.005)
    }

    func test44_1kInputIsResampledToo() throws {
        var signal = Interleaved(sampleRate: 44_100, channels: 1, frames: 88_200) { t, _ in sine(1_000, amplitude: 0.25, at: t) }
        let output = try resample(&signal, chunk: 441)
        XCTAssertEqual(Double(output.count), 32_000, accuracy: 64)
        let steady = output[1_000..<31_000]
        XCTAssertEqual(dominantFrequency(steady, sampleRate: 16_000, around: 1_000), 1_000, accuracy: 0.2)
        XCTAssertEqual(rms(steady) * 2.squareRoot() / fullScale, 0.25, accuracy: 0.003)
    }

    func testDownmixAveragesChannels() throws {
        // Left only: half amplitude. Opposite phases: cancel.
        var leftOnly = Interleaved(sampleRate: 48_000, channels: 2, frames: 48_000) { t, c in c == 0 ? sine(440, amplitude: 0.8, at: t) : 0 }
        let left = try resample(&leftOnly, chunk: 480)
        XCTAssertEqual(rms(left[1_000..<15_000]) * 2.squareRoot() / fullScale, 0.4, accuracy: 0.005)

        var antiphase = Interleaved(sampleRate: 48_000, channels: 2, frames: 48_000) { t, c in sine(440, amplitude: c == 0 ? 0.8 : -0.8, at: t) }
        XCTAssertLessThan(try resample(&antiphase, chunk: 480).map { abs(Int($0)) }.max()!, 2)
    }

    func testPlanarBuffersAreDownmixedLikeInterleaved() throws {
        let frames = 4_800
        var left = (0..<frames).map { sine(440, amplitude: 0.6, at: Double($0) / 48_000) }
        var right = [Float](repeating: 0, count: frames)
        let resampler = try MonoResampler(inputSampleRate: 48_000, maxInputFrames: frames)
        let output = left.withUnsafeMutableBytes { l in
            right.withUnsafeMutableBytes { r in
                let list = AudioBufferList.allocate(maximumBuffers: 2)
                defer { free(list.unsafeMutablePointer) }
                list[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(l.count), mData: l.baseAddress)
                list[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(r.count), mData: r.baseAddress)
                return Array(resampler.process(list.unsafePointer, startFrame: 0, frameCount: frames))
            }
        }
        XCTAssertEqual(rms(output[200..<1_300]) * 2.squareRoot() / fullScale, 0.3, accuracy: 0.005)
    }

    func testContentAboveNyquistIsFilteredNotAliased() throws {
        // 12 kHz would alias to 4 kHz without an anti-aliasing filter.
        var signal = Interleaved(sampleRate: 48_000, channels: 1, frames: 48_000) { t, _ in sine(12_000, amplitude: 0.9, at: t) }
        let output = try resample(&signal, chunk: 512)
        XCTAssertLessThan(rms(output[1_000..<15_000]) / fullScale, 0.9 / 2.squareRoot() * 0.01)  // < -40 dB
    }

    func testClipsInsteadOfWrapping() throws {
        var signal = Interleaved(sampleRate: 16_000, channels: 1, frames: 16_000) { t, _ in sine(200, amplitude: 1.5, at: t) }
        let output = try resample(&signal, chunk: 160)
        XCTAssertEqual(output.max(), .max)
        XCTAssertEqual(output.min(), .min)
        // A wrapped sample would flip sign next to a full-scale neighbour.
        XCTAssertFalse(zip(output, output.dropFirst()).contains { abs(Int($0) - Int($1)) > 20_000 })
    }

    func testChunkingDoesNotChangeOutput() throws {
        var signal = Interleaved(sampleRate: 48_000, channels: 2, frames: 48_000) { t, c in
            sine(300, amplitude: 0.3, at: t) + sine(2_710, amplitude: c == 0 ? 0.2 : 0.1, at: t)
        }
        let whole = try resample(&signal, chunk: 48_000)
        // 4800 exceeds the converter's internal slice, so it must buffer the remainder itself
        // rather than keep reading from our (by then overwritten) input buffer.
        for chunk in [333, 4_800] {
            let pieces = try resample(&signal, chunk: chunk)
            let common = min(whole.count, pieces.count)
            XCTAssertGreaterThan(common, 15_700)
            XCTAssertEqual(Array(whole.prefix(common)), Array(pieces.prefix(common)), "chunk \(chunk)")
        }
    }
}
