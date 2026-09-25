import Foundation

// Writes to a closed pipe must fail with EPIPE, which the capture writer handles, instead of
// killing the process.
signal(SIGPIPE, SIG_IGN)

let usage = """
    usage: granola-helper capture
           granola-helper devices
           granola-helper permissions [--request microphone|calendar|system_audio]
           granola-helper calendar list
           granola-helper calendar events --from <ISO8601> --to <ISO8601> [--calendars id,id]
           granola-helper watch
    """

let arguments = Array(CommandLine.arguments.dropFirst())
switch (arguments.first, arguments.dropFirst().first) {
case ("capture", nil):
    CaptureSession.run()
case ("devices", nil):
    runOneShot(DevicesCommand.run)
case ("permissions", _):
    runOneShot { try PermissionsCommand.run(Array(arguments.dropFirst())) }
case ("calendar", "list"):
    runOneShot { try CalendarCommand.list(Array(arguments.dropFirst(2))) }
case ("watch", nil):
    WatchCommand.run()
case ("calendar", "events"):
    runOneShot { try CalendarCommand.events(Array(arguments.dropFirst(2))) }
default:
    runOneShot { () throws -> [String: String] in throw CommandError.usage(usage) }
}
