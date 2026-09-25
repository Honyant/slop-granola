import XCTest
@testable import HelperCore

final class EventTests: XCTestCase {
    private func json(_ event: HelperEvent) -> String { String(decoding: event.jsonData(), as: UTF8.self) }

    func testStartedWithMic() {
        let mic = MicDescriptor(uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", voiceProcessing: true)
        XCTAssertEqual(json(.started(t0UnixMs: 1_790_000_000_000, mic: mic, system: true)),
                       #"{"event":"started","mic":{"name":"MacBook Pro Microphone","uid":"BuiltInMicrophoneDevice","voice_processing":true},"system":true,"t0_unix_ms":1790000000000}"#)
    }

    func testStartedWithoutMicEncodesNull() {
        XCTAssertEqual(json(.started(t0UnixMs: 5, mic: nil, system: false)),
                       #"{"event":"started","mic":null,"system":false,"t0_unix_ms":5}"#)
    }

    func testErrorAndStopped() {
        XCTAssertEqual(json(.error(source: .mic, code: .permissionDenied, message: "no")),
                       #"{"code":"permission_denied","event":"error","fatal":false,"message":"no","source":"mic"}"#)
        XCTAssertEqual(json(.stopped), #"{"event":"stopped"}"#)
    }
}
