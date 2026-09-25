import XCTest
@testable import HelperCore

final class ChunkStamperTests: XCTestCase {
    func testContiguousChunksFollowSampleCount() {
        var stamper = ChunkStamper(inputSampleRate: 48_000, toleranceSamples: 80)
        XCTAssertEqual(stamper.place(inputFrames: 480, inputPosition: 1000, outputSamples: 160), 1000)
        XCTAssertEqual(stamper.place(inputFrames: 480, inputPosition: 1160, outputSamples: 160), 1160)
    }

    func testResamplerBacklogShiftsChunkEarlier() {
        var stamper = ChunkStamper(inputSampleRate: 48_000, toleranceSamples: 0)
        // First call: 480 frames in (= 160 output samples' worth) but only 150 out.
        XCTAssertEqual(stamper.place(inputFrames: 480, inputPosition: 0, outputSamples: 150), 0)
        // The 10 held-back samples come out first in the next call, so its first output sample
        // is 10 samples before the new buffer's own position.
        XCTAssertEqual(stamper.place(inputFrames: 480, inputPosition: 160, outputSamples: 160), 150)
    }

    func testJitterWithinToleranceIsAbsorbed() {
        var stamper = ChunkStamper(inputSampleRate: 16_000, toleranceSamples: 80)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 0, outputSamples: 160), 0)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 160 + 79, outputSamples: 160), 160)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 320 - 80, outputSamples: 160), 320)
    }

    func testStallBeyondToleranceReanchorsOnHostTime() {
        var stamper = ChunkStamper(inputSampleRate: 16_000, toleranceSamples: 80)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 0, outputSamples: 160), 0)
        // 500 ms of input never arrived: the next chunk starts where it was captured.
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 8_160, outputSamples: 160), 8_160)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 8_320, outputSamples: 160), 8_320)
    }

    func testMissingHostTimeContinuesFromPreviousChunk() {
        var stamper = ChunkStamper(inputSampleRate: 16_000, toleranceSamples: 80)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: 400, outputSamples: 160), 400)
        XCTAssertEqual(stamper.place(inputFrames: 160, inputPosition: nil, outputSamples: 160), 560)
    }
}
