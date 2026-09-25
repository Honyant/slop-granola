import XCTest
@testable import HelperCore

final class FrameTests: XCTestCase {
    func testAudioHeaderLayout() {
        var bytes = [UInt8](repeating: 0xAA, count: Frame.audioHeaderSize)
        Frame.writeAudioHeader(to: &bytes, source: .system, sampleIndex: 0x0102_0304_0506_0708, sampleCount: 3)
        XCTAssertEqual(bytes, [
            0x01,                                           // type
            0x0F, 0x00, 0x00, 0x00,                         // length = 9 + 3 * 2
            0x01,                                           // source = system
            0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, // sample_index LE
        ])
    }

    func testEventFrame() throws {
        let frame = Frame.event(json: Data(#"{"event":"stopped"}"#.utf8))
        XCTAssertEqual(Array(frame.prefix(5)), [0x02, 19, 0, 0, 0])
        XCTAssertEqual(try decodeFrames(frame), [.event(["event": "stopped"])])
    }

    func testAudioFrameRoundTripsThroughRing() throws {
        let ring = FrameRing(source: .mic, capacity: 1024)
        let samples: [Int16] = [0, 1, -1, .max, .min]
        samples.withUnsafeBufferPointer { XCTAssertTrue(ring.pushAudio(sampleIndex: 42, samples: $0)) }
        XCTAssertEqual(try peekFrames(ring), [.audio(source: 0, sampleIndex: 42, samples: samples)])
    }
}
