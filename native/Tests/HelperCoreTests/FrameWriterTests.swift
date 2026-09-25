import XCTest
@testable import HelperCore

final class FrameWriterTests: XCTestCase {
    override class func setUp() {
        signal(SIGPIPE, SIG_IGN)
    }

    private struct Pipe {
        let read: Int32
        let write: Int32
        init() {
            var fds: [Int32] = [0, 0]
            precondition(Darwin.pipe(&fds) == 0)
            (read, write) = (fds[0], fds[1])
        }
    }

    private func readAll(_ fd: Int32) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let n = Darwin.read(fd, &buffer, buffer.count)
            if n <= 0 { return data }
            data.append(buffer, count: n)
        }
    }

    private func startWriter(fd: Int32) -> (FrameWriter, XCTestExpectation, () -> FrameWriter.Exit?) {
        let exited = expectation(description: "writer exited")
        var exit: FrameWriter.Exit?
        let writer = FrameWriter(fd: fd) { exit = $0; exited.fulfill() }
        writer.start()
        return (writer, exited, { exit })
    }

    func testAudioIsHeldUntilReleasedSoStartedComesFirstAndStoppedLast() throws {
        let pipe = Pipe()
        let (writer, exited, exit) = startWriter(fd: pipe.write)
        let ring = writer.makeRing(source: .system, capacity: 4_096)
        let samples: [Int16] = [1, 2, 3]
        samples.withUnsafeBufferPointer {
            ring.pushAudio(sampleIndex: 0, samples: $0)
            ring.pushAudio(sampleIndex: 3, samples: $0)
        }
        usleep(20_000)  // Give the writer every chance to (wrongly) write the audio now.
        writer.send(.started(t0UnixMs: 1, mic: nil, system: true))
        writer.releaseAudio()
        writer.retire(ring)
        writer.finish()
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(exit(), .finished)
        close(pipe.write)

        let frames = try decodeFrames(readAll(pipe.read))
        XCTAssertEqual(frames.first?.eventName, "started")
        XCTAssertEqual(Array(frames[1...2]), [
            .audio(source: 1, sampleIndex: 0, samples: samples),
            .audio(source: 1, sampleIndex: 3, samples: samples),
        ])
        XCTAssertEqual(frames.last?.eventName, "stopped")
        XCTAssertEqual(frames.count, 4)
    }

    func testStalledReaderCausesBoundedDropsThatAreReported() throws {
        let pipe = Pipe()
        let (writer, exited, exit) = startWriter(fd: pipe.write)
        // One second of audio per ring; produce ten seconds while nobody reads stdout.
        writer.releaseAudio()
        let ring = writer.makeRing(source: .mic, capacity: FrameRing.capacity(seconds: 1, minChunkSamples: 1_600))
        let chunk = [Int16](repeating: 100, count: 1_600)
        var accepted = 0
        chunk.withUnsafeBufferPointer {
            for n in 0..<100 where ring.pushAudio(sampleIndex: UInt64(n * 1_600), samples: $0) { accepted += 1 }
        }
        XCTAssertLessThan(accepted, 100, "the ring must not grow without bound")

        var output = Data()
        let drained = expectation(description: "pipe drained")
        DispatchQueue.global().async { output = self.readAll(pipe.read); drained.fulfill() }
        writer.retire(ring)
        writer.finish()
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(exit(), .finished)
        close(pipe.write)
        wait(for: [drained], timeout: 5)

        let frames = try decodeFrames(output)
        let audio = frames.filter { if case .audio = $0 { return true } else { return false } }
        XCTAssertEqual(audio.count, accepted)
        let errors = frames.compactMap { frame -> [String: AnyHashable]? in
            guard case let .event(json) = frame, json["event"] as? String == "error" else { return nil }
            return json
        }
        // The writer reports what was dropped each time it catches up, so a long stall can be
        // reported in several events; together they must account for every dropped chunk.
        XCTAssertFalse(errors.isEmpty)
        XCTAssertTrue(errors.allSatisfy { $0["source"] as? String == "mic" && $0["code"] as? String == "internal" })
        let reportedMs = errors.compactMap { ($0["message"] as? String)?.split(separator: " ")[1] }.compactMap { Int($0) }
        XCTAssertEqual(reportedMs.reduce(0, +), (100 - accepted) * 100)
        XCTAssertEqual(frames.last?.eventName, "stopped")
    }

    func testClosedReaderEndsWriterWithEPIPE() {
        let pipe = Pipe()
        close(pipe.read)
        let (writer, exited, exit) = startWriter(fd: pipe.write)
        writer.send(.stopped)
        wait(for: [exited], timeout: 5)
        XCTAssertEqual(exit(), .writeFailed(errno: EPIPE))
        close(pipe.write)
    }
}
