import Foundation

/// Owns stdout during capture. A dedicated thread drains queued events and every stream's
/// `FrameRing` to the file descriptor; no other thread writes to it.
///
/// Per wake-up the thread writes pending events first, then each ring. Audio is held back
/// entirely until `releaseAudio()`, so the session can start its sources and still have its
/// `started` event (sent just before releasing) come first. `finish()` writes `stopped` after
/// everything else.
///
/// A blocked `write` stalls only this thread. Producers keep filling their rings and start
/// dropping once a ring is full; the drop is reported as an `error` event when writing resumes.
public final class FrameWriter {
    public enum Exit: Equatable {
        /// `finish()` completed and `stopped` was written.
        case finished
        /// Writing failed (EPIPE when the reader has gone away).
        case writeFailed(errno: Int32)
    }

    private let fd: Int32
    private let onExit: (Exit) -> Void
    private let wake = DispatchSemaphore(value: 0)

    private let lock = NSLock()
    // Guarded by `lock`.
    private var events: [HelperEvent] = []
    private var rings: [FrameRing] = []
    private var retired: [FrameRing] = []
    private var audioReleased = false
    private var finishing = false

    /// - Parameter onExit: called once, on the writer thread, when the thread ends.
    public init(fd: Int32, onExit: @escaping (Exit) -> Void) {
        self.fd = fd
        self.onExit = onExit
    }

    public func start() {
        let thread = Thread { [self] in run() }
        thread.name = "granola-helper.writer"
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    /// Creates a ring for a new stream. It is drained until `retire` is called.
    public func makeRing(source: AudioSource, capacity: Int) -> FrameRing {
        let ring = FrameRing(source: source, capacity: capacity, wake: wake)
        lock.withLock { rings.append(ring) }
        return ring
    }

    /// Call after the ring's producer has stopped. The ring is drained one last time, then released.
    public func retire(_ ring: FrameRing) {
        lock.withLock {
            rings.removeAll { $0 === ring }
            retired.append(ring)
        }
        wake.signal()
    }

    public func send(_ event: HelperEvent) {
        lock.withLock { events.append(event) }
        wake.signal()
    }

    /// Starts writing audio. Events sent before this call are written before any audio.
    public func releaseAudio() {
        lock.withLock { audioReleased = true }
        wake.signal()
    }

    /// Drains everything queued so far, writes `stopped` and ends the thread.
    public func finish() {
        lock.withLock { finishing = true }
        wake.signal()
    }

    private func run() {
        while true {
            wake.wait()
            let (events, rings, finishing) = lock.withLock {
                let events = self.events
                self.events.removeAll()
                guard audioReleased || self.finishing else { return (events, [FrameRing](), false) }
                let rings = self.rings + retired
                retired.removeAll()
                return (events, rings, self.finishing)
            }
            do {
                for event in events { try write(Frame.event(json: event.jsonData())) }
                for ring in rings { try drain(ring) }
                if finishing {
                    try write(Frame.event(json: HelperEvent.stopped.jsonData()))
                    onExit(.finished)
                    return
                }
            } catch {
                onExit(.writeFailed(errno: (error as? WriteError)?.errno ?? EIO))
                return
            }
        }
    }

    private func drain(_ ring: FrameRing) throws {
        let (first, second) = ring.readableRegions()
        try write(first)
        try write(second)
        ring.consume(first.count + second.count)

        let dropped = ring.takeNewlyDroppedSamples()
        if dropped > 0 {
            let milliseconds = dropped * 1000 / UInt64(Timeline.sampleRate)
            let event = HelperEvent.error(
                source: ring.source == .mic ? .mic : .system, code: .internal,
                message: "dropped \(milliseconds) ms of audio because stdout was not read fast enough")
            try write(Frame.event(json: event.jsonData()))
        }
    }

    private struct WriteError: Error { let errno: Int32 }

    private func write(_ data: Data) throws {
        try data.withUnsafeBytes { try write($0) }
    }

    private func write(_ bytes: UnsafeRawBufferPointer) throws {
        var offset = 0
        while offset < bytes.count {
            let n = Darwin.write(fd, bytes.baseAddress! + offset, bytes.count - offset)
            if n < 0 {
                if errno == EINTR { continue }
                throw WriteError(errno: errno)
            }
            offset += n
        }
    }
}
