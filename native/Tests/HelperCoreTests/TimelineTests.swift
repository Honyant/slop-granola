import XCTest
@testable import HelperCore

final class TimelineTests: XCTestCase {
    /// Apple Silicon: 24 MHz ticks, 125/3 ns each.
    let appleSilicon = HostTimebase(numer: 125, denom: 3)

    func testOneSecondOfAppleSiliconTicksIs16000Samples() {
        let timeline = Timeline(originHostTime: 1_000_000, timebase: appleSilicon)
        XCTAssertEqual(timeline.position(ofHostTime: 1_000_000), 0)
        XCTAssertEqual(timeline.position(ofHostTime: 1_000_000 + 24_000_000), 16_000, accuracy: 1e-6)
        XCTAssertEqual(timeline.position(ofHostTime: 1_000_000 + 1_500), 1, accuracy: 1e-9)  // 62.5 µs
    }

    func testNanosecondTimebase() {
        let timeline = Timeline(originHostTime: 0, timebase: HostTimebase(numer: 1, denom: 1))
        XCTAssertEqual(timeline.position(ofHostTime: 1_000_000_000), 16_000, accuracy: 1e-6)
        XCTAssertEqual(timeline.position(ofHostTime: 62_500), 1, accuracy: 1e-9)
    }

    func testBeforeOriginIsNegative() {
        let timeline = Timeline(originHostTime: 24_000_000, timebase: appleSilicon)
        XCTAssertEqual(timeline.position(ofHostTime: 12_000_000), -8_000, accuracy: 1e-6)
    }

    func testDayLongSessionKeepsSubSamplePrecision() {
        let origin: UInt64 = 5_000_000_000_000  // ~2.3 days of uptime
        let timeline = Timeline(originHostTime: origin, timebase: appleSilicon)
        let day: UInt64 = 24 * 3600 * 24_000_000
        XCTAssertEqual(timeline.position(ofHostTime: origin + day + 1_500), 16_000 * 86_400 + 1, accuracy: 1e-3)
    }

    func testCurrentTimebaseMatchesWallClock() {
        let start = mach_absolute_time()
        let wallStart = DispatchTime.now().uptimeNanoseconds
        usleep(50_000)
        let elapsedSamples = Timeline(originHostTime: start).position(ofHostTime: mach_absolute_time())
        let wallSamples = Double(DispatchTime.now().uptimeNanoseconds - wallStart) * 16e-6
        XCTAssertEqual(elapsedSamples, wallSamples, accuracy: 16)  // 1 ms
    }
}
