import CoreAudio
import Foundation

struct CoreAudioError: Error, CustomStringConvertible {
    let status: OSStatus
    let operation: String
    var description: String { "\(operation) failed (OSStatus \(status))" }
}

func check(_ status: OSStatus, _ operation: @autoclosure () -> String) throws {
    guard status == noErr else { throw CoreAudioError(status: status, operation: operation()) }
}

/// Thin typed access to Core Audio HAL object properties.
enum HAL {
    static let system = AudioObjectID(kAudioObjectSystemObject)

    static func address(
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    /// Reads a fixed-size (POD) property.
    static func value<T>(
        _ object: AudioObjectID,
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
        initial: T
    ) throws -> T {
        var address = address(selector, scope)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
        }
        try check(status, "get '\(fourCC(selector))' of object \(object)")
        return value
    }

    static func array<T>(
        _ object: AudioObjectID,
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
        of: T.Type
    ) throws -> [T] {
        var address = address(selector, scope)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size), "size of '\(fourCC(selector))'")
        let count = Int(size) / MemoryLayout<T>.stride
        guard count > 0 else { return [] }
        return try [T](unsafeUninitializedCapacity: count) { buffer, initialized in
            try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, buffer.baseAddress!),
                      "get '\(fourCC(selector))' of object \(object)")
            initialized = Int(size) / MemoryLayout<T>.stride
        }
    }

    /// Reads a CFString property; the HAL returns it retained.
    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        let value: Unmanaged<CFString>? = try value(object, selector, initial: nil)
        guard let value else { throw CoreAudioError(status: kAudioHardwareUnspecifiedError, operation: "'\(fourCC(selector))' is null") }
        return value.takeRetainedValue() as String
    }

    // MARK: Devices

    static func defaultInputDevice() -> AudioDeviceID? {
        let id = try? value(system, kAudioHardwarePropertyDefaultInputDevice, initial: AudioDeviceID(kAudioObjectUnknown))
        return id == kAudioObjectUnknown ? nil : id
    }

    static func device(uid: String) -> AudioDeviceID? {
        var address = address(kAudioHardwarePropertyTranslateUIDToDevice)
        var cfUID = uid as CFString
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = withUnsafePointer(to: &cfUID) {
            AudioObjectGetPropertyData(system, &address, UInt32(MemoryLayout<CFString>.size), $0, &size, &device)
        }
        return status == noErr && device != kAudioObjectUnknown ? device : nil
    }

    static func hasInput(_ device: AudioDeviceID) -> Bool {
        let streams = try? array(device, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput, of: AudioStreamID.self)
        return !(streams ?? []).isEmpty
    }

    static func inputDevices() throws -> [AudioDeviceID] {
        try array(system, kAudioHardwarePropertyDevices, of: AudioDeviceID.self).filter(hasInput)
    }

    // MARK: Processes

    static func processObjects() throws -> [AudioObjectID] {
        try array(system, kAudioHardwarePropertyProcessObjectList, of: AudioObjectID.self)
    }

    static func pid(ofProcessObject object: AudioObjectID) -> pid_t? {
        try? value(object, kAudioProcessPropertyPID, initial: pid_t(-1))
    }

    static func fourCC(_ code: UInt32) -> String {
        String(bytes: [24, 16, 8, 0].map { UInt8(truncatingIfNeeded: code >> $0) }, encoding: .macOSRoman) ?? "\(code)"
    }
}

/// A HAL property listener that is removed when this object is released.
final class PropertyListener {
    private let object: AudioObjectID
    private var address: AudioObjectPropertyAddress
    private let queue: DispatchQueue
    private let block: AudioObjectPropertyListenerBlock

    init(
        _ object: AudioObjectID,
        _ selector: AudioObjectPropertySelector,
        queue: DispatchQueue = .main,
        handler: @escaping () -> Void
    ) throws {
        self.object = object
        self.queue = queue
        address = HAL.address(selector)
        block = { _, _ in handler() }
        try check(AudioObjectAddPropertyListenerBlock(object, &address, queue, block),
                  "listen to '\(HAL.fourCC(selector))'")
    }

    deinit {
        AudioObjectRemovePropertyListenerBlock(object, &address, queue, block)
    }
}
