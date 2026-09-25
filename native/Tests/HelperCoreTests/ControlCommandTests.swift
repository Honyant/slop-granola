import XCTest
@testable import HelperCore

final class ControlCommandTests: XCTestCase {
    func testStartFromSpec() throws {
        let line = #"{"cmd": "start", "mic": {"enabled": true, "device_uid": null, "voice_processing": true}, "system": {"enabled": true}}"#
        XCTAssertEqual(try ControlCommand.parse(line),
                       .start(CaptureConfig(mic: MicConfig(deviceUID: nil, voiceProcessing: true), system: true)))
    }

    func testStartWithPinnedMicAndNoSystem() throws {
        let line = #"{"cmd":"start","mic":{"enabled":true,"device_uid":"BuiltInMicrophoneDevice","voice_processing":false},"system":{"enabled":false}}"#
        XCTAssertEqual(try ControlCommand.parse(line),
                       .start(CaptureConfig(mic: MicConfig(deviceUID: "BuiltInMicrophoneDevice", voiceProcessing: false), system: false)))
    }

    func testDisabledMicNeedsNoOtherFields() throws {
        XCTAssertEqual(try ControlCommand.parse(#"{"cmd":"start","mic":{"enabled":false},"system":{"enabled":true}}"#),
                       .start(CaptureConfig(mic: nil, system: true)))
    }

    func testSetMicAndStop() throws {
        XCTAssertEqual(try ControlCommand.parse(#"{"cmd": "set_mic", "device_uid": "BuiltInMicrophoneDevice"}"#),
                       .setMic(deviceUID: "BuiltInMicrophoneDevice"))
        XCTAssertEqual(try ControlCommand.parse(#"{"cmd": "set_mic", "device_uid": null}"#), .setMic(deviceUID: nil))
        XCTAssertEqual(try ControlCommand.parse(#"{"cmd": "stop"}"#), .stop)
    }

    func testUnknownFieldsAreIgnored() throws {
        XCTAssertEqual(try ControlCommand.parse(#"{"cmd": "stop", "reason": "user"}"#), .stop)
    }

    func testRejections() {
        assertRejected(#"{"cmd": "set_mic"}"#, "missing device_uid")
        assertRejected(#"{"cmd": "start", "mic": {"enabled": true, "device_uid": null}, "system": {"enabled": true}}"#,
                       "missing mic.voice_processing")
        assertRejected(#"{"cmd": "start", "mic": {"enabled": false}}"#, "missing system")
        assertRejected(#"{"cmd": "set_mic", "device_uid": 7}"#, "wrong type for device_uid")
        assertRejected(#"{"cmd": "pause"}"#, #"unknown cmd "pause""#)
        assertRejected(#"{"device_uid": null}"#, "missing cmd")
        assertRejected("start", "not a JSON object")
        assertRejected("[1]", "not a JSON object")
    }

    private func assertRejected(_ line: String, _ reason: String, file: StaticString = #filePath, line number: UInt = #line) {
        XCTAssertThrowsError(try ControlCommand.parse(line), file: file, line: number) { error in
            XCTAssertEqual((error as? ControlCommand.ParseError)?.description, reason, file: file, line: number)
        }
    }
}
