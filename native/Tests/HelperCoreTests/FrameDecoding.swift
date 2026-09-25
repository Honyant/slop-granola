import Foundation
@testable import HelperCore

/// Test-side parser for the stdout protocol.
enum DecodedFrame: Equatable {
    case audio(source: UInt8, sampleIndex: UInt64, samples: [Int16])
    case event([String: AnyHashable])

    var eventName: String? {
        if case let .event(json) = self { return json["event"] as? String }
        return nil
    }
}

struct FrameDecodingError: Error { let reason: String }

func decodeFrames(_ data: Data) throws -> [DecodedFrame] {
    var frames: [DecodedFrame] = []
    try data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
        var offset = 0
        while offset < bytes.count {
            guard bytes.count - offset >= Frame.headerSize else { throw FrameDecodingError(reason: "truncated header") }
            let type = bytes[offset]
            let length = Int(UInt32(littleEndian: bytes.loadUnaligned(fromByteOffset: offset + 1, as: UInt32.self)))
            let payload = offset + Frame.headerSize
            guard bytes.count - payload >= length else { throw FrameDecodingError(reason: "truncated payload") }
            switch type {
            case Frame.audioType:
                guard length >= Frame.audioPrefixSize, (length - Frame.audioPrefixSize) % 2 == 0 else {
                    throw FrameDecodingError(reason: "bad audio length \(length)")
                }
                let index = UInt64(littleEndian: bytes.loadUnaligned(fromByteOffset: payload + 1, as: UInt64.self))
                let count = (length - Frame.audioPrefixSize) / 2
                let samples = (0..<count).map {
                    Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: payload + Frame.audioPrefixSize + 2 * $0, as: Int16.self))
                }
                frames.append(.audio(source: bytes[payload], sampleIndex: index, samples: samples))
            case Frame.eventType:
                let json = Data(bytes[payload..<payload + length])
                guard let object = try JSONSerialization.jsonObject(with: json) as? [String: AnyHashable] else {
                    throw FrameDecodingError(reason: "event is not an object")
                }
                frames.append(.event(object))
            default:
                throw FrameDecodingError(reason: "unknown type \(type)")
            }
            offset = payload + length
        }
    }
    return frames
}

/// Reads everything a ring currently holds without consuming it.
func peekFrames(_ ring: FrameRing) throws -> [DecodedFrame] {
    let (first, second) = ring.readableRegions()
    return try decodeFrames(Data(first) + Data(second))
}
