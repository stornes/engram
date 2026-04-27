import Foundation
import EventKit

let store = EKEventStore()

let group = DispatchGroup()
group.enter()

store.requestAccess(to: .event) { (granted, error) in
    if !granted {
        print("[]")
        exit(1)
    }
    group.leave()
}
group.wait()

let args = CommandLine.arguments
var dayOffset = 0
if let idx = args.firstIndex(of: "--offset"), idx + 1 < args.count {
    dayOffset = Int(args[idx+1]) ?? 0
}

let cal = Calendar.current
let now = Date()
let targetDay = cal.date(byAdding: .day, value: dayOffset, to: now)!
let startOfDay = cal.startOfDay(for: targetDay)
let endOfDay = cal.date(byAdding: .day, value: 1, to: startOfDay)!

let predicate = store.predicateForEvents(withStart: startOfDay, end: endOfDay, calendars: nil)
let events = store.events(matching: predicate)

let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime]

var results: [[String: Any]] = []

for e in events {
    var dict: [String: Any] = [:]
    dict["title"] = e.title ?? ""
    dict["startDate"] = formatter.string(from: e.startDate)
    dict["endDate"] = formatter.string(from: e.endDate)
    dict["isAllDay"] = e.isAllDay
    dict["location"] = e.location ?? ""
    dict["calendar"] = e.calendar?.title ?? ""
    dict["notes"] = e.notes ?? ""
    
    if let attendees = e.attendees {
        dict["attendees"] = attendees.map { $0.name ?? $0.url.absoluteString }
    } else {
        dict["attendees"] = []
    }
    
    results.append(dict)
}

if let jsonData = try? JSONSerialization.data(withJSONObject: results, options: .prettyPrinted),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    print("[]")
}
