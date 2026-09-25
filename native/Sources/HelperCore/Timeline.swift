import Darwin

/// Conversion factor from `mach_absolute_time` ticks to nanoseconds. On Apple Silicon a tick
/// is 125/3 ns (24 MHz), not 1 ns, so host times must never be treated as nanoseconds.
public struct HostTimebase: Equatable, Sendable {
    public let numer: UInt32
    public let denom: UInt32

    public init(numer: UInt32, denom: UInt32) {
        precondition(numer > 0 && denom > 0)
        self.numer = numer
        self.denom = denom
    }

    public static let current: HostTimebase = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return HostTimebase(numer: info.numer, denom: info.denom)
    }()
}

/// The shared 16 kHz timeline of a capture session. Position 0 is the host time at which
/// `start` was processed.
public struct Timeline: Sendable {
    public static let sampleRate = 16_000

    public let originHostTime: UInt64
    private let samplesPerTick: Double

    public init(originHostTime: UInt64, timebase: HostTimebase = .current) {
        self.originHostTime = originHostTime
        samplesPerTick = Double(timebase.numer) / Double(timebase.denom) * Double(Self.sampleRate) / 1e9
    }

    /// Timeline position of `hostTime`, in fractional 16 kHz samples; negative before the origin.
    /// A Double is exact here: tick deltas stay below 2^53 for years, and the result needs
    /// sub-sample precision only.
    public func position(ofHostTime hostTime: UInt64) -> Double {
        let deltaTicks = hostTime >= originHostTime
            ? Double(hostTime - originHostTime)
            : -Double(originHostTime - hostTime)
        return deltaTicks * samplesPerTick
    }
}
