import Foundation
import HelperCore

/// Per stream, ten seconds of audio (in chunks of at least 10 ms) may wait for stdout before
/// newer audio is dropped.
let streamRingCapacity = FrameRing.capacity(seconds: 10, minChunkSamples: 160)

/// The `capture` subcommand. All state lives on the main queue; the stdin reader thread only
/// forwards lines to it, and stdout belongs to the `FrameWriter` thread.
final class CaptureSession {
    private enum State { case idle, running, stopping }

    private let writer: FrameWriter
    private var state = State.idle
    private var mic: MicSource?
    private var system: SystemAudioSource?
    /// Events raised by sources while `start` runs, held back so `started` comes first.
    private var eventsDuringStart: [HelperEvent]?
    private var signalSources: [DispatchSourceSignal] = []

    static func run() -> Never {
        // The protocol writer expects blocking writes; a pipe inherited in non-blocking mode
        // would otherwise turn a slow reader into EAGAIN.
        _ = fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) & ~O_NONBLOCK)
        let session = CaptureSession()
        session.writer.start()
        session.handleTerminationSignals()
        session.readStdin()
        dispatchMain()
    }

    private init() {
        writer = FrameWriter(fd: STDOUT_FILENO) { exit in
            DispatchQueue.main.async { CaptureSession.writerExited(exit) }
        }
    }

    // MARK: Control

    private func readStdin() {
        let reader = Thread { [self] in
            while let line = readLine() {
                DispatchQueue.main.async { self.handle(line) }
            }
            DispatchQueue.main.async { self.shutdown() }
        }
        reader.name = "granola-helper.stdin"
        reader.start()
    }

    private func handleTerminationSignals() {
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdown() }
            source.resume()
            signalSources.append(source)
        }
    }

    private func handle(_ line: String) {
        guard state != .stopping, !line.allSatisfy(\.isWhitespace) else { return }
        let command: ControlCommand
        do {
            command = try ControlCommand.parse(line)
        } catch {
            return rejectCommand("\(error): \(line.prefix(200))")
        }
        switch command {
        case let .start(config):
            guard state == .idle else { return rejectCommand("capture has already been started") }
            start(config)
        case let .setMic(deviceUID):
            guard let mic else { return rejectCommand("set_mic needs a running capture with the mic enabled") }
            mic.select(deviceUID: deviceUID)
        case .stop:
            shutdown()
        }
    }

    private func rejectCommand(_ message: String) {
        report(.error(source: .control, code: .invalidCommand, message: message))
    }

    private func report(_ event: HelperEvent) {
        if eventsDuringStart != nil {
            eventsDuringStart!.append(event)
        } else {
            writer.send(event)
        }
    }

    // MARK: Lifecycle

    private func start(_ config: CaptureConfig) {
        state = .running
        let timeline = Timeline(originHostTime: mach_absolute_time())
        let t0UnixMs = Int64((Date().timeIntervalSince1970 * 1000).rounded())
        eventsDuringStart = []

        var systemRunning = false
        if config.system {
            let source = SystemAudioSource(timeline: timeline, writer: writer, report: report)
            do {
                try source.start()
                system = source
                systemRunning = true
            } catch {
                report(.error(source: .system, code: .deviceUnavailable, message: "system audio capture failed: \(error)"))
            }
        }
        var micDescriptor: MicDescriptor?
        if let micConfig = config.mic {
            let source = MicSource(config: micConfig, timeline: timeline, writer: writer, report: report)
            micDescriptor = source.start()
            mic = source
        }

        writer.send(.started(t0UnixMs: t0UnixMs, mic: micDescriptor, system: systemRunning))
        eventsDuringStart!.forEach(writer.send)
        eventsDuringStart = nil
        writer.releaseAudio()
    }

    /// Stops the sources, then lets the writer flush and write `stopped`; the process exits
    /// when it has. Idempotent.
    private func shutdown() {
        guard state != .stopping else { return }
        state = .stopping
        mic?.stop()
        system?.stop()
        writer.finish()
        // A parent that is alive but no longer reading would block the final flush forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            log("stdout not drained within 2 s of stopping; exiting anyway")
            exit(0)
        }
    }

    private static func writerExited(_ exit: FrameWriter.Exit) -> Never {
        switch exit {
        case .finished:
            Darwin.exit(0)
        case .writeFailed(EPIPE):
            // The reader (the app) is gone; there is nobody left to report to.
            log("stdout closed by reader; exiting")
            Darwin.exit(0)
        case let .writeFailed(errno):
            log("writing stdout failed: \(String(cString: strerror(errno)))")
            Darwin.exit(1)
        }
    }
}
