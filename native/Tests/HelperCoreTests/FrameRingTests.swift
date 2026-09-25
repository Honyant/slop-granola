import XCTest
@testable import HelperCore

final class FrameRingTests: XCTestCase {
    private let tenSamples = [Int16](repeating: 7, count: 10)
    private var frameSize: Int { Frame.audioFrameSize(sampleCount: 10) }

    private func push(_ ring: FrameRing, _ index: UInt64) -> Bool {
        tenSamples.withUnsafeBufferPointer { ring.pushAudio(sampleIndex: index, samples: $0) }
    }

    func testFullRingDropsWholeFramesAndCountsSamples() throws {
        let ring = FrameRing(source: .mic, capacity: 2 * frameSize)
        XCTAssertTrue(push(ring, 0))
        XCTAssertTrue(push(ring, 10))
        XCTAssertFalse(push(ring, 20))
        XCTAssertFalse(push(ring, 30))
        XCTAssertEqual(ring.takeNewlyDroppedSamples(), 20)
        XCTAssertEqual(ring.takeNewlyDroppedSamples(), 0)
        // Nothing partial was published.
        XCTAssertEqual(try peekFrames(ring), [
            .audio(source: 0, sampleIndex: 0, samples: tenSamples),
            .audio(source: 0, sampleIndex: 10, samples: tenSamples),
        ])
    }

    func testConsumingMakesRoomAndFramesWrapAround() throws {
        // Capacity not a multiple of the frame size, so the third frame straddles the end.
        let ring = FrameRing(source: .system, capacity: 2 * frameSize + 5)
        XCTAssertTrue(push(ring, 0))
        XCTAssertTrue(push(ring, 10))
        ring.consume(frameSize)
        XCTAssertTrue(push(ring, 20))
        let (first, second) = ring.readableRegions()
        XCTAssertFalse(second.isEmpty, "expected the data to wrap")
        XCTAssertEqual(first.count + second.count, 2 * frameSize)
        XCTAssertEqual(try peekFrames(ring), [
            .audio(source: 1, sampleIndex: 10, samples: tenSamples),
            .audio(source: 1, sampleIndex: 20, samples: tenSamples),
        ])
    }

    func testProducerAndConsumerOnDifferentThreadsLoseNothingWhenKeepingUp() throws {
        let ring = FrameRing(source: .mic, capacity: 64 * frameSize + 3)
        let count = 100_000
        let producer = Thread { [self] in
            var index: UInt64 = 0
            while index < UInt64(count) * 10 {
                if push(ring, index) { index += 10 }
            }
        }
        producer.start()
        var received = Data()
        while received.count < count * frameSize {
            let (first, second) = ring.readableRegions()
            received += Data(first) + Data(second)
            ring.consume(first.count + second.count)
        }
        let frames = try decodeFrames(received)
        XCTAssertEqual(frames.count, count)
        for (n, frame) in frames.enumerated() {
            XCTAssertEqual(frame, .audio(source: 0, sampleIndex: UInt64(n * 10), samples: tenSamples))
        }
    }
}
