import AudioToolbox
import Foundation

/// Interleaved Float32 test signal.
struct Interleaved {
    let sampleRate: Double
    let channels: Int
    var samples: [Float]

    var frameCount: Int { samples.count / channels }

    init(sampleRate: Double, channels: Int, frames: Int, _ value: (_ time: Double, _ channel: Int) -> Float) {
        self.sampleRate = sampleRate
        self.channels = channels
        samples = (0..<frames * channels).map { value(Double($0 / channels) / sampleRate, $0 % channels) }
    }

    /// Calls `body` with an AudioBufferList covering the whole signal.
    mutating func withBufferList<R>(_ body: (UnsafePointer<AudioBufferList>) throws -> R) rethrows -> R {
        let channels = self.channels
        return try samples.withUnsafeMutableBytes { bytes in
            var list = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
            return try body(&list)
        }
    }
}

func sine(_ frequency: Double, amplitude: Double, at time: Double) -> Float {
    Float(amplitude * sin(2 * .pi * frequency * time))
}

func rms(_ samples: ArraySlice<Int16>) -> Double {
    (samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count)).squareRoot()
}

/// Frequency with the largest DFT magnitude, searched on a 0.1 Hz grid.
func dominantFrequency(_ samples: ArraySlice<Int16>, sampleRate: Double, around center: Double) -> Double {
    let grid = stride(from: center - 20, through: center + 20, by: 0.1)
    return grid.max { magnitude(samples, $0, sampleRate) < magnitude(samples, $1, sampleRate) }!
}

private func magnitude(_ samples: ArraySlice<Int16>, _ frequency: Double, _ sampleRate: Double) -> Double {
    var re = 0.0, im = 0.0
    for (n, x) in samples.enumerated() {
        let phase = 2 * .pi * frequency * Double(n) / sampleRate
        re += Double(x) * cos(phase)
        im -= Double(x) * sin(phase)
    }
    return re * re + im * im
}
