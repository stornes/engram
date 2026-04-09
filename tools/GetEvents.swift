#!/usr/bin/env swift

import EventKit
import Foundation

// MARK: - Configuration

let args = CommandLine.arguments
let dayOffset: Int
let filterCalendar: String?

// Parse arguments
var offset = 0
var calFilter: String? = nil

var i = 1
while i < args.count {
    switch args[i] {
    case "--tomorrow":
        offset = 1
    case "--today":
        offset = 0
    case "--offset":
        i += 1
        if i < args.count, let val = Int(args[i]) {
            offset = val
        }
    case "--calendar":
        i += 1
        if i < args.count {
            calFilter = args[i]
        }
    case "--json":
        break // JSON is default output
    case "--help":
        print("""
        Usage: GetEvents.swift [options]

        Options:
          --today        Show today's events (default)
          --tomorrow     Show tomorrow's events
          --offset N     Show events N days from today
          --calendar X   Filter to specific calendar name
          --help         Show this help
        """)
        exit(0)
    default:
        break
    }
    i += 1
}

dayOffset = offset
filterCalendar = calFilter

// MARK: - EventKit Access

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var accessGranted = false

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { granted, error in
        accessGranted = granted
        if let error = error {
            fputs("Error requesting access: \(error.localizedDescription)\n", stderr)
        }
        semaphore.signal()
    }
} else {
    store.requestAccess(to: .event) { granted, error in
        accessGranted = granted
        if let error = error {
            fputs("Error requesting access: \(error.localizedDescription)\n", stderr)
        }
        semaphore.signal()
    }
}

semaphore.wait()

guard accessGranted else {
    fputs("{\"error\": \"Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars.\"}\n", stderr)
    exit(1)
}

// MARK: - Date Range

let calendar = Calendar.current
let now = Date()
let targetDate = calendar.date(byAdding: .day, value: dayOffset, to: now)!
let startOfDay = calendar.startOfDay(for: targetDate)
let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay)!

// MARK: - Fetch Events

let predicate = store.predicateForEvents(withStart: startOfDay, end: endOfDay, calendars: nil)
let events = store.events(matching: predicate)

// Optional calendar filter
let filtered: [EKEvent]
if let calName = filterCalendar {
    filtered = events.filter { $0.calendar.title.lowercased() == calName.lowercased() }
} else {
    filtered = events
}

// Sort by start date, all-day events first
let sorted = filtered.sorted { a, b in
    if a.isAllDay != b.isAllDay {
        return a.isAllDay
    }
    return a.startDate < b.startDate
}

// MARK: - Output

let dateFormatter = DateFormatter()
dateFormatter.dateFormat = "yyyy-MM-dd"

let timeFormatter = DateFormatter()
timeFormatter.dateFormat = "HH:mm"

let fullFormatter = DateFormatter()
fullFormatter.dateFormat = "EEEE d MMMM yyyy"

var output: [[String: Any]] = []

for event in sorted {
    var dict: [String: Any] = [
        "title": event.title ?? "(No title)",
        "calendar": event.calendar.title,
        "isAllDay": event.isAllDay,
        "startDate": dateFormatter.string(from: event.startDate),
        "startTime": event.isAllDay ? "all-day" : timeFormatter.string(from: event.startDate),
        "endTime": event.isAllDay ? "all-day" : timeFormatter.string(from: event.endDate),
    ]

    if let location = event.location, !location.isEmpty {
        dict["location"] = location
    }

    if let notes = event.notes, !notes.isEmpty {
        // Truncate long notes (e.g. Teams meeting boilerplate)
        let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count > 500 {
            dict["notes"] = String(trimmed.prefix(500)) + "..."
        } else {
            dict["notes"] = trimmed
        }
    }

    if let url = event.url {
        dict["url"] = url.absoluteString
    }

    // Attendees
    if let attendees = event.attendees, !attendees.isEmpty {
        let names = attendees.compactMap { participant -> String? in
            if let name = participant.name {
                return name
            }
            return participant.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
        }
        if !names.isEmpty {
            dict["attendees"] = names
        }
    }

    // Organiser
    if let organizer = event.organizer?.name {
        dict["organiser"] = organizer
    }

    // Status
    switch event.status {
    case .tentative:
        dict["status"] = "tentative"
    case .confirmed:
        dict["status"] = "confirmed"
    case .canceled:
        dict["status"] = "cancelled"
    default:
        break
    }

    output.append(dict)
}

// Build JSON manually since JSONSerialization needs NSObject types
let meta: [String: Any] = [
    "date": dateFormatter.string(from: targetDate),
    "dateFormatted": fullFormatter.string(from: targetDate),
    "dayOffset": dayOffset,
    "totalEvents": sorted.count,
]

// Use JSONSerialization for proper output
let result: [String: Any] = [
    "meta": meta,
    "events": output
]

if let jsonData = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    fputs("{\"error\": \"Failed to serialise events to JSON\"}\n", stderr)
    exit(1)
}
