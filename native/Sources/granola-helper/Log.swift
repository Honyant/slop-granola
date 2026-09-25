import Foundation

/// Human-readable diagnostics. stderr only: stdout carries protocol data.
func log(_ message: String) {
    FileHandle.standardError.write(Data("granola-helper: \(message)\n".utf8))
}
