import Foundation

public struct MicConfig: Equatable, Sendable {
    /// nil follows the system default input, including changes to it.
    public var deviceUID: String?
    public var voiceProcessing: Bool

    public init(deviceUID: String?, voiceProcessing: Bool) {
        self.deviceUID = deviceUID
        self.voiceProcessing = voiceProcessing
    }
}

public struct CaptureConfig: Equatable, Sendable {
    /// nil when the mic is disabled.
    public var mic: MicConfig?
    public var system: Bool

    public init(mic: MicConfig?, system: Bool) {
        self.mic = mic
        self.system = system
    }
}

/// One JSON line on stdin.
public enum ControlCommand: Equatable, Sendable {
    case start(CaptureConfig)
    case setMic(deviceUID: String?)
    case stop

    public struct ParseError: Error, Equatable, CustomStringConvertible {
        public let description: String
    }

    /// Strict: every field the protocol shows is required (`device_uid` may be null). Unknown
    /// fields are ignored so the app can add fields before the helper understands them.
    public static func parse(_ line: String) throws -> ControlCommand {
        do {
            return try JSONDecoder().decode(Wire.self, from: Data(line.utf8)).command
        } catch let error as ParseError {
            throw error
        } catch let DecodingError.keyNotFound(key, context) {
            throw ParseError(description: "missing \(path(context.codingPath + [key]))")
        } catch let DecodingError.typeMismatch(_, context) where !context.codingPath.isEmpty,
                let DecodingError.valueNotFound(_, context) where !context.codingPath.isEmpty {
            throw ParseError(description: "wrong type for \(path(context.codingPath))")
        } catch {
            throw ParseError(description: "not a JSON object")
        }
    }

    private static func path(_ keys: [CodingKey]) -> String {
        keys.map(\.stringValue).joined(separator: ".")
    }

    private struct Wire: Decodable {
        let command: ControlCommand

        private enum Key: String, CodingKey { case cmd, mic, system, deviceUID = "device_uid" }
        private struct Mic: Decodable {
            let enabled: Bool
            let deviceUID: String?
            let voiceProcessing: Bool

            private enum Key: String, CodingKey {
                case enabled, deviceUID = "device_uid", voiceProcessing = "voice_processing"
            }
            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Key.self)
                enabled = try container.decode(Bool.self, forKey: .enabled)
                // A disabled mic needs no further configuration.
                guard enabled else {
                    deviceUID = nil
                    voiceProcessing = false
                    return
                }
                deviceUID = try container.decodePresent(String?.self, forKey: .deviceUID)
                voiceProcessing = try container.decode(Bool.self, forKey: .voiceProcessing)
            }
        }
        private struct System: Decodable { let enabled: Bool }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Key.self)
            switch try container.decode(String.self, forKey: .cmd) {
            case "start":
                let mic = try container.decode(Mic.self, forKey: .mic)
                let system = try container.decode(System.self, forKey: .system)
                command = .start(CaptureConfig(
                    mic: mic.enabled ? MicConfig(deviceUID: mic.deviceUID, voiceProcessing: mic.voiceProcessing) : nil,
                    system: system.enabled))
            case "set_mic":
                command = .setMic(deviceUID: try container.decodePresent(String?.self, forKey: .deviceUID))
            case "stop":
                command = .stop
            case let other:
                throw ParseError(description: "unknown cmd \"\(other)\"")
            }
        }
    }
}

private extension KeyedDecodingContainer {
    /// Decodes a nullable field whose key must be present: absent is an error, null is nil.
    func decodePresent<T: Decodable>(_ type: T?.Type, forKey key: Key) throws -> T? {
        guard contains(key) else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "required"))
        }
        return try decodeNil(forKey: key) ? nil : decode(T.self, forKey: key)
    }
}
