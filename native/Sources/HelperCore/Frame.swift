import Foundation

#if !_endian(little)
#error("PCM is copied verbatim into s16le frames; a big-endian host would need byte swapping.")
#endif

/// Which capture stream an audio frame belongs to. Raw values are the wire encoding.
public enum AudioSource: UInt8, Sendable {
    case mic = 0
    case system = 1
}

/// Wire format of stdout: `type:u8 | length:u32 LE | payload[length]`.
public enum Frame {
    public static let audioType: UInt8 = 0x01
    public static let eventType: UInt8 = 0x02

    /// type + length.
    public static let headerSize = 5
    /// Audio payload prefix: source + sample_index.
    public static let audioPrefixSize = 9
    public static let audioHeaderSize = headerSize + audioPrefixSize

    public static func audioFrameSize(sampleCount: Int) -> Int {
        audioHeaderSize + sampleCount * MemoryLayout<Int16>.size
    }

    /// Writes the 14 bytes that precede the PCM of an audio frame.
    public static func writeAudioHeader(
        to destination: UnsafeMutableRawPointer,
        source: AudioSource,
        sampleIndex: UInt64,
        sampleCount: Int
    ) {
        let payloadLength = UInt32(audioPrefixSize + sampleCount * MemoryLayout<Int16>.size)
        destination.storeBytes(of: audioType, as: UInt8.self)
        destination.storeBytes(of: payloadLength.littleEndian, toByteOffset: 1, as: UInt32.self)
        destination.storeBytes(of: source.rawValue, toByteOffset: 5, as: UInt8.self)
        destination.storeBytes(of: sampleIndex.littleEndian, toByteOffset: 6, as: UInt64.self)
    }

    public static func event(json: Data) -> Data {
        var frame = Data(capacity: headerSize + json.count)
        frame.append(eventType)
        withUnsafeBytes(of: UInt32(json.count).littleEndian) { frame.append(contentsOf: $0) }
        frame.append(json)
        return frame
    }
}
