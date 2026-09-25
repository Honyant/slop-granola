import Foundation

/// Error output of one-shot subcommands: `{"error": {"code", "message"}}`, exit status 1.
struct CommandError: Error {
    let code: String
    let message: String

    static func usage(_ message: String) -> CommandError { CommandError(code: "invalid_arguments", message: message) }
    static func permissionDenied(_ message: String) -> CommandError { CommandError(code: "permission_denied", message: message) }
    static func `internal`(_ message: String) -> CommandError { CommandError(code: "internal", message: message) }
}

/// Runs a one-shot subcommand: prints its result as one JSON document and exits 0, or prints
/// the error document and exits 1.
func runOneShot(_ body: () throws -> some Encodable) -> Never {
    do {
        printJSON(try body())
        exit(0)
    } catch let error as CommandError {
        printJSON(["error": ["code": error.code, "message": error.message]])
        exit(1)
    } catch {
        printJSON(["error": ["code": "internal", "message": "\(error)"]])
        exit(1)
    }
}

private func printJSON(_ value: some Encodable) {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // The result types contain only strings, numbers, bools and nulls.
    var data = try! encoder.encode(value)
    data.append(UInt8(ascii: "\n"))
    FileHandle.standardOutput.write(data)
}

/// Blocks the calling thread until `start` calls its completion. For framework APIs that
/// only offer completion handlers, in a process with nothing else to do meanwhile.
func waitFor<T>(_ start: (@escaping (T) -> Void) -> Void) -> T {
    let done = DispatchSemaphore(value: 0)
    var result: T?
    start { value in
        result = value
        done.signal()
    }
    done.wait()
    return result!
}
