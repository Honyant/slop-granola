import CAtomics
import Dispatch

/// Bounded single-producer/single-consumer byte ring that carries complete audio frames from
/// an audio callback thread to the writer thread.
///
/// Producer side (`pushAudio`) takes no locks, allocates nothing and never blocks, so it is
/// safe on a Core Audio IO thread. When the ring is full the frame is dropped whole and
/// counted; the consumer turns the count into an `error` event. Only complete frames are ever
/// published, so the consumer can write every readable byte without parsing.
///
/// Positions are monotonically increasing byte counters (never reset); the storage offset is
/// `counter % capacity`. Each counter has exactly one writing thread.
public final class FrameRing {
    public let source: AudioSource
    public let capacity: Int

    private let storage: UnsafeMutablePointer<UInt8>
    private let header: UnsafeMutableRawPointer
    /// Bytes published by the producer. Written by the producer only.
    private let written: UnsafeMutablePointer<UInt64>
    /// Bytes consumed by the writer. Written by the consumer only.
    private let consumed: UnsafeMutablePointer<UInt64>
    /// Samples the producer dropped because the ring was full. Written by the producer only.
    private let dropped: UnsafeMutablePointer<UInt64>
    /// Portion of `dropped` already reported. Consumer-owned.
    private var droppedReported: UInt64 = 0
    private let wake: DispatchSemaphore?

    /// - Parameter wake: signalled after each published frame so the consumer can sleep.
    public init(source: AudioSource, capacity: Int, wake: DispatchSemaphore? = nil) {
        precondition(capacity > Frame.audioHeaderSize)
        self.source = source
        self.capacity = capacity
        self.wake = wake
        storage = .allocate(capacity: capacity)
        header = .allocate(byteCount: Frame.audioHeaderSize, alignment: 8)
        written = .allocate(capacity: 1)
        consumed = .allocate(capacity: 1)
        dropped = .allocate(capacity: 1)
        written.initialize(to: 0)
        consumed.initialize(to: 0)
        dropped.initialize(to: 0)
    }

    /// Capacity holding `seconds` of 16 kHz s16 audio plus framing overhead for chunks of at
    /// least `minChunkSamples`.
    public static func capacity(seconds: Double, minChunkSamples: Int) -> Int {
        let samples = Int(seconds * Double(Timeline.sampleRate))
        let frames = samples / minChunkSamples + 1
        return samples * MemoryLayout<Int16>.size + frames * Frame.audioHeaderSize
    }

    deinit {
        storage.deallocate()
        header.deallocate()
        written.deallocate()
        consumed.deallocate()
        dropped.deallocate()
    }

    // MARK: Producer

    /// Publishes one audio frame, or drops it if it does not fit. Real-time safe.
    @discardableResult
    public func pushAudio(sampleIndex: UInt64, samples: UnsafeBufferPointer<Int16>) -> Bool {
        let frameSize = Frame.audioFrameSize(sampleCount: samples.count)
        let head = written.pointee
        let used = Int(head - ga_load_acquire(consumed))
        guard capacity - used >= frameSize else {
            ga_store_release(dropped, dropped.pointee + UInt64(samples.count))
            return false
        }
        Frame.writeAudioHeader(to: header, source: source, sampleIndex: sampleIndex, sampleCount: samples.count)
        copyIn(UnsafeRawPointer(header), count: Frame.audioHeaderSize, at: head)
        if let base = samples.baseAddress {
            copyIn(UnsafeRawPointer(base), count: samples.count * MemoryLayout<Int16>.size,
                   at: head + UInt64(Frame.audioHeaderSize))
        }
        ga_store_release(written, head + UInt64(frameSize))
        wake?.signal()
        return true
    }

    private func copyIn(_ source: UnsafeRawPointer, count: Int, at position: UInt64) {
        let offset = Int(position % UInt64(capacity))
        let firstPart = min(count, capacity - offset)
        (storage + offset).update(from: source.assumingMemoryBound(to: UInt8.self), count: firstPart)
        if firstPart < count {
            storage.update(from: source.assumingMemoryBound(to: UInt8.self) + firstPart, count: count - firstPart)
        }
    }

    // MARK: Consumer

    /// All published, unconsumed bytes as at most two contiguous regions (the second is
    /// non-empty only when the data wraps). Always a whole number of frames.
    public func readableRegions() -> (UnsafeRawBufferPointer, UnsafeRawBufferPointer) {
        let tail = consumed.pointee
        let available = Int(ga_load_acquire(written) - tail)
        let offset = Int(tail % UInt64(capacity))
        let firstPart = min(available, capacity - offset)
        return (
            UnsafeRawBufferPointer(start: storage + offset, count: firstPart),
            UnsafeRawBufferPointer(start: storage, count: available - firstPart)
        )
    }

    public func consume(_ byteCount: Int) {
        ga_store_release(consumed, consumed.pointee + UInt64(byteCount))
    }

    /// Samples dropped since the previous call.
    public func takeNewlyDroppedSamples() -> UInt64 {
        let total = ga_load_acquire(dropped)
        defer { droppedReported = total }
        return total - droppedReported
    }
}
