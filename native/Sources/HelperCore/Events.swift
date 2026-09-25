import Foundation

/// The input device a running mic stream actually uses.
public struct MicDescriptor: Equatable, Encodable, Sendable {
    public let uid: String
    public let name: String
    /// Whether Apple voice processing is active. It can be false even when requested: voice
    /// processing always captures the system default input, so it is only used on that device.
    public let voiceProcessing: Bool

    public init(uid: String, name: String, voiceProcessing: Bool) {
        self.uid = uid
        self.name = name
        self.voiceProcessing = voiceProcessing
    }
}

public enum EventSource: String, Encodable, Sendable {
    case mic, system, control
}

public enum ErrorCode: String, Encodable, Sendable {
    case permissionDenied = "permission_denied"
    case deviceUnavailable = "device_unavailable"
    case invalidCommand = "invalid_command"
    case `internal`
}

/// A JSON event frame on stdout.
public enum HelperEvent: Equatable, Sendable {
    case started(t0UnixMs: Int64, mic: MicDescriptor?, system: Bool)
    case micChanged(MicDescriptor)
    /// Errors are never fatal: an unrecoverable failure ends the process instead.
    case error(source: EventSource, code: ErrorCode, message: String)
    case stopped

    public func jsonData() -> Data {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Encoding plain strings, numbers and bools cannot fail.
        return try! encoder.encode(self)
    }
}

extension HelperEvent: Encodable {
    private enum Key: String, CodingKey {
        case event, t0UnixMs, mic, system, source, code, message, fatal
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case let .started(t0UnixMs, mic, system):
            try container.encode("started", forKey: .event)
            try container.encode(t0UnixMs, forKey: .t0UnixMs)
            try container.encode(mic, forKey: .mic)
            try container.encode(system, forKey: .system)
        case let .micChanged(mic):
            try container.encode("mic_changed", forKey: .event)
            try container.encode(mic, forKey: .mic)
        case let .error(source, code, message):
            try container.encode("error", forKey: .event)
            try container.encode(source, forKey: .source)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
            try container.encode(false, forKey: .fatal)
        case .stopped:
            try container.encode("stopped", forKey: .event)
        }
    }
}
