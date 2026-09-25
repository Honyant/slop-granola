import CoreGraphics
import EventKit
import Foundation

enum CalendarCommand {
    struct CalendarList: Encodable {
        struct Calendar: Encodable {
            let id: String
            let title: String
            @Nullable var color: String?
            let source: String
            let allowsModify: Bool
            /// The calendar new events go into, which the app treats as the user's primary one.
            let isDefault: Bool
        }
        let calendars: [Calendar]
    }

    struct EventList: Encodable {
        struct Participant: Encodable {
            @Nullable var name: String?
            @Nullable var email: String?
            let status: String
            let isSelf: Bool
        }
        struct Event: Encodable {
            /// Unique per occurrence: EventKit gives every occurrence of a recurring event the
            /// same `eventIdentifier`, so the occurrence's original start is appended.
            let id: String
            let calendarId: String
            let title: String
            let start: String
            let end: String
            let allDay: Bool
            @Nullable var location: String?
            @Nullable var url: String?
            @Nullable var notes: String?
            @Nullable var organizer: Participant?
            let attendees: [Participant]
        }
        let events: [Event]
    }

    static func list(_ arguments: [String]) throws -> CalendarList {
        guard arguments.isEmpty else { throw CommandError.usage("usage: calendar list") }
        let store = try authorizedStore()
        let defaultID = store.defaultCalendarForNewEvents?.calendarIdentifier
        return CalendarList(calendars: store.calendars(for: .event).map { calendar in
            CalendarList.Calendar(
                id: calendar.calendarIdentifier,
                title: calendar.title,
                color: calendar.cgColor.flatMap(hex),
                source: calendar.source?.title ?? "",
                allowsModify: calendar.allowsContentModifications,
                isDefault: calendar.calendarIdentifier == defaultID)
        })
    }

    static func events(_ arguments: [String]) throws -> EventList {
        let usage = CommandError.usage("usage: calendar events --from <ISO8601> --to <ISO8601> [--calendars id,id]")
        var options: [String: String] = [:]
        var remaining = arguments[...]
        while let flag = remaining.popFirst() {
            guard ["--from", "--to", "--calendars"].contains(flag), options[flag] == nil,
                  let value = remaining.popFirst() else { throw usage }
            options[flag] = value
        }
        guard let fromText = options["--from"], let toText = options["--to"] else { throw usage }
        guard let from = parseDate(fromText), let to = parseDate(toText) else {
            throw CommandError.usage("--from and --to must be ISO 8601 date-times with an offset")
        }
        guard from < to else { throw CommandError.usage("--from must be before --to") }
        // EventKit silently truncates longer ranges to their first four years.
        guard to.timeIntervalSince(from) <= 4 * 365 * 86_400 else {
            throw CommandError.usage("the range may span at most four years")
        }

        let store = try authorizedStore()
        var calendars: [EKCalendar]?
        if let ids = options["--calendars"] {
            // Unknown ids are skipped: an app's saved selection may name a deleted calendar.
            calendars = ids.split(separator: ",").compactMap { store.calendar(withIdentifier: String($0)) }
            if calendars!.isEmpty { return EventList(events: []) }
        }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
        let events = store.events(matching: predicate).sorted { (a: EKEvent, b: EKEvent) in
            a.startDate != b.startDate ? a.startDate < b.startDate : (a.eventIdentifier ?? "") < (b.eventIdentifier ?? "")
        }
        return EventList(events: events.map(describe))
    }

    private static func authorizedStore() throws -> EKEventStore {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw CommandError.permissionDenied("calendar full access is not granted (run `permissions --request calendar`)")
        }
        return EKEventStore()
    }

    private static func describe(_ event: EKEvent) -> EventList.Event {
        let occurrence = event.occurrenceDate ?? event.startDate!
        return EventList.Event(
            id: "\(event.eventIdentifier ?? "")@\(Int64(occurrence.timeIntervalSince1970))",
            calendarId: event.calendar.calendarIdentifier,
            title: event.title ?? "",
            start: formatDate(event.startDate),
            end: formatDate(event.endDate),
            allDay: event.isAllDay,
            location: event.location,
            url: event.url?.absoluteString,
            notes: event.notes,
            organizer: event.organizer.map(describe),
            attendees: (event.attendees ?? []).map(describe))
    }

    private static func describe(_ participant: EKParticipant) -> EventList.Participant {
        let url = participant.url
        let email = url.scheme?.lowercased() == "mailto"
            ? (url as NSURL).resourceSpecifier?.removingPercentEncoding
            : nil
        return EventList.Participant(
            name: participant.name,
            email: email,
            status: status(participant.participantStatus),
            isSelf: participant.isCurrentUser)
    }

    private static func status(_ status: EKParticipantStatus) -> String {
        switch status {
        case .pending: return "pending"
        case .accepted: return "accepted"
        case .declined: return "declined"
        case .tentative: return "tentative"
        case .delegated: return "delegated"
        case .completed: return "completed"
        case .inProcess: return "in_process"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    private static func hex(_ color: CGColor) -> String? {
        guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = color.converted(to: sRGB, intent: .defaultIntent, options: nil),
              let components = converted.components, components.count >= 3
        else { return nil }
        let bytes = components.prefix(3).map { Int((min(max($0, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", bytes[0], bytes[1], bytes[2])
    }

    private static func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: text)
    }

    private static func formatDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        return formatter.string(from: date)
    }
}

/// Encodes nil as `null`; synthesized `Encodable` would omit the key instead.
@propertyWrapper
struct Nullable<Value: Encodable>: Encodable {
    var wrappedValue: Value?

    init(wrappedValue: Value?) {
        self.wrappedValue = wrappedValue
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wrappedValue)
    }
}
