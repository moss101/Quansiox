// Quansiox human-demonstration capture helper (GPA G3).
//
// A minimal, listen-only CGEventTap that streams human mouse/keyboard actions
// as newline-delimited JSON to a Unix-domain socket:
//   {"type":"ready"}
//   {"type":"click","x":..,"y":..,"button":0,"clickCount":1}
//   {"type":"key","keyCode":0,"text":"a","modifiers":["cmd"]}
//   {"type":"scroll","x":..,"y":..,"deltaY":-3}
//   {"type":"error","error":"..."}
//
// Requires Accessibility (and, on recent macOS, Input Monitoring) permission
// for the signed app. If the tap cannot be created the helper reports the
// reason and exits non-zero — it never pretends to capture.
import Foundation
import ApplicationServices

var clientFd: Int32 = -1
var socketPath = ""

func sendLine(_ object: [String: Any]) {
    guard clientFd >= 0 else { return }
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let written = write(clientFd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}

func modifiers(_ event: CGEvent) -> [String] {
    let flags = event.flags
    var out: [String] = []
    if flags.contains(.maskCommand) { out.append("cmd") }
    if flags.contains(.maskShift) { out.append("shift") }
    if flags.contains(.maskAlternate) { out.append("alt") }
    if flags.contains(.maskControl) { out.append("ctrl") }
    return out
}

func unicodeText(_ event: CGEvent) -> String {
    var length = 0
    var chars = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &chars)
    guard length > 0 else { return "" }
    return String(utf16CodeUnits: chars, count: length)
}

func handle(_ type: CGEventType, _ event: CGEvent) {
    let point = event.location
    switch type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        let button = type == .rightMouseDown ? 1 : (type == .otherMouseDown ? 2 : 0)
        let clicks = event.getIntegerValueField(.mouseEventClickState)
        sendLine(["type": "click", "x": point.x, "y": point.y, "button": button, "clickCount": clicks > 0 ? clicks : 1])
    case .scrollWheel:
        let delta = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
        sendLine(["type": "scroll", "x": point.x, "y": point.y, "deltaY": delta])
    case .keyDown:
        let text = unicodeText(event)
        sendLine([
            "type": "key",
            "keyCode": Int(event.getIntegerValueField(.keyboardEventKeycode)),
            "text": text,
            "modifiers": modifiers(event),
        ])
    default:
        break
    }
}

let callback: CGEventTapCallBack = { _, type, event, _ in
    // Disabled taps must be re-enabled or capture silently stops.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        return Unmanaged.passUnretained(event)
    }
    handle(type, event)
    return Unmanaged.passUnretained(event)
}

func fail(_ message: String, code: Int32) -> Never {
    sendLine(["type": "error", "error": message])
    if !socketPath.isEmpty { unlink(socketPath) }
    exit(code)
}

guard CommandLine.arguments.count >= 2 else { fail("usage: QuansioxCapture <socket-path>", code: 64) }
socketPath = CommandLine.arguments[1]
unlink(socketPath)

let server = socket(AF_UNIX, SOCK_STREAM, 0)
if server < 0 { fail("socket() failed", code: 70) }
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(socketPath.utf8)
if pathBytes.count >= MemoryLayout.size(ofValue: addr.sun_path) { fail("socket path too long", code: 64) }
withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    raw.copyBytes(from: pathBytes)
}
let bound = withUnsafePointer(to: &addr) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
if bound != 0 { fail("bind failed", code: 71) }
if listen(server, 1) != 0 { fail("listen failed", code: 72) }

// Report permission before accepting so the client can fail closed fast.
let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
let mask = (1 << CGEventType.keyDown.rawValue)
    | (1 << CGEventType.leftMouseDown.rawValue)
    | (1 << CGEventType.rightMouseDown.rawValue)
    | (1 << CGEventType.otherMouseDown.rawValue)
    | (1 << CGEventType.scrollWheel.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(mask),
    callback: callback,
    userInfo: nil
) else {
    fail(trusted
        ? "could not create the event tap (Input Monitoring permission?)"
        : "Accessibility permission is required (System Settings → Privacy & Security → Accessibility)", code: 73)
}

clientFd = accept(server, nil, nil)
if clientFd < 0 { fail("accept failed", code: 74) }
sendLine(["type": "ready"])

atexit {
    if clientFd >= 0 { close(clientFd) }
    if !socketPath.isEmpty { unlink(socketPath) }
}
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
CFRunLoopRun()
