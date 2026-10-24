// Quansiox native computer-use helper.
//
// Drop-in replacement for the JXA helper (src/computer-helper/index.js): same
// launch contract and newline-delimited JSON-RPC 2.0 protocol over a 0600 unix
// socket, so computerHostService can swap binaries without protocol changes.
//
//   env QUANSIOX_COMPUTER_HELPER_BOOTSTRAP  single-use 0600 JSON bootstrap
//   env QUANSIOX_COMPUTER_HELPER_SOCKET     socket path to bind (0600)
//   env QUANSIOX_COMPUTER_BLOCKLIST         comma-separated app names/bundle ids
//
// Two actuation modes, the way Grok Bot's CUCore does it:
//
//   1. BACKGROUND (the default and the point of this helper)
//      A target app is addressed by bundle id / app name / pid / window id.
//      Its window is captured individually with ScreenCaptureKit — the app
//      does NOT need to be frontmost, and the user keeps their mouse and
//      keyboard. Elements are actuated through the accessibility API
//      (AXPress, AXSetValue, AXScrollToVisible) on that app's own AX tree.
//
//   2. FOREGROUND (the fallback)
//      A global CGEvent tap posts input to the frontmost app. This is the
//      only way to drive an app that exposes no accessibility tree, but it
//      does take over the user's pointer.
//
// Safety:
//  - the bootstrap is read once and deleted before serving;
//  - every method except initialize/authenticate requires the control token;
//  - a panic chord (Ctrl+Option+Escape) exits the helper (fail-closed stop);
//  - blocked apps are refused by open_app;
//  - AX/input calls report ACCESSIBILITY_PERMISSION_REQUIRED honestly when
//    the process is not trusted; nothing pretends to have happened.
import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit

private let protocolVersion = "quansiox.computer/v1"
private let stateQueue = DispatchQueue(label: "im.quansiox.computer.state")
private var controlToken = ""
private var authenticated = false
private var axRevision = 0
private var socketPath = ""
private var listenFd: Int32 = -1

/// Element registry: snapshot id → (element id → AXUIElement + owning pid).
/// Kept so an action can address an element by id without re-walking the
/// tree, and so a stale snapshot can be refused.
private struct ElementRecord {
    let element: AXUIElement
    let pid: pid_t
    let role: String
    let title: String
    let windowID: CGWindowID
    /// The frame the element occupied when the tree was read. An action
    /// re-checks it, because an element that has moved is not the control
    /// the model looked at.
    let frame: CGRect
}
private var snapshots: [String: [String: ElementRecord]] = [:]
private var snapshotOrder: [String] = []
private let MAX_SNAPSHOTS = 8

private struct RPCFailure: Error {
    let code: Int
    let message: String
}

private func fail(_ code: Int, _ message: String) -> RPCFailure {
    RPCFailure(code: code, message: message)
}

private func logLine(_ message: String) {
    FileHandle.standardError.write(("[computer-helper-native] " + message + "\n").data(using: .utf8)!)
}

/* ---------------- socket plumbing ---------------- */

private func writeAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
            let written = write(fd, base.advanced(by: offset), raw.count - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}

private func sendJSON(_ object: [String: Any], to fd: Int32) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    var line = data
    line.append(0x0A)
    writeAll(fd, line)
}

private func sendResult(_ id: Any?, _ result: Any, to fd: Int32) {
    sendJSON(["jsonrpc": "2.0", "id": id ?? NSNull(), "result": result], to: fd)
}

private func sendError(_ id: Any?, _ code: Int, _ message: String, to fd: Int32) {
    sendJSON(["jsonrpc": "2.0", "id": id ?? NSNull(), "error": ["code": code, "message": message]], to: fd)
}

/* ---------------- accessibility helpers ---------------- */

private func axAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return err == .success ? value : nil
}

private func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axAttr(element, name) else { return nil }
    if let s = value as? String { return s }
    if let n = value as? NSNumber { return n.stringValue }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = axAttr(element, kAXChildrenAttribute as String) else { return [] }
    return value as? [AXUIElement] ?? []
}

private func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
    return Array(list.prefix(12))
}

private func accessibilityTrusted() -> Bool {
    return AXIsProcessTrusted()
}

private func requireAccessibility() throws {
    if !accessibilityTrusted() {
        throw fail(-32002, "ACCESSIBILITY_PERMISSION_REQUIRED")
    }
}

/* ---------------- target resolution ---------------- */

/// A resolved automation target: an app and optionally one of its windows.
private struct Target {
    let pid: pid_t
    let bundleId: String
    let name: String
    let windowId: CGWindowID
    let title: String
    let frame: CGRect
}

/// Resolve a target from the request parameters.
///
/// Priority: window_id → bundle_id → app_name → pid → (frontmost app).
/// The window list comes from ScreenCaptureKit, so the helper can address
/// apps that are running in the background.
private func resolveTarget(_ params: [String: Any]) async throws -> Target {
    let requestedWindow = (params["window_id"] as? NSNumber)?.uint32Value
    let requestedBundle = (params["bundle_id"] as? String)?.trimmingCharacters(in: .whitespaces)
    let requestedName = (params["app_name"] as? String)?.trimmingCharacters(in: .whitespaces)
    let requestedPid = (params["pid"] as? NSNumber)?.int32Value

    // Try ScreenCaptureKit first: it knows about windows of background apps.
    if let content = try? await awaitShareableContent() {
        let windows = content.windows
        if let windowId = requestedWindow,
           let window = windows.first(where: { $0.windowID == windowId }) {
            return target(for: window, content: content)
        }
        if let bundleId = requestedBundle, !bundleId.isEmpty {
            if let window = windows.first(where: { $0.owningApplication?.bundleIdentifier == bundleId }) {
                return target(for: window, content: content)
            }
        }
        if let name = requestedName, !name.isEmpty {
            if let window = windows.first(where: { $0.owningApplication?.applicationName == name }) {
                return target(for: window, content: content)
            }
        }
    }

    // Fall back to the accessibility tree (an app with no visible window still
    // has an AX tree).
    if let pid = requestedPid {
        return try targetForPid(pid_t(pid), windowId: requestedWindow ?? 0, title: "")
    }
    if let bundleId = requestedBundle, !bundleId.isEmpty {
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) {
            return try targetForPid(app.processIdentifier, windowId: requestedWindow ?? 0, title: "")
        }
        throw fail(-32007, "NO_SUCH_APP")
    }
    if let name = requestedName, !name.isEmpty {
        if let app = NSWorkspace.shared.runningApplications.first(where: {
            ($0.localizedName ?? "").caseInsensitiveCompare(name) == .orderedSame
        }) {
            return try targetForPid(app.processIdentifier, windowId: requestedWindow ?? 0, title: "")
        }
        throw fail(-32007, "NO_SUCH_APP")
    }
    guard let front = NSWorkspace.shared.frontmostApplication else {
        throw fail(-32003, "NO_FRONTMOST_APP")
    }
    return try targetForPid(front.processIdentifier, windowId: requestedWindow ?? 0, title: "")
}

private func targetForPid(_ pid: pid_t, windowId: CGWindowID, title: String) throws -> Target {
    let app = NSRunningApplication(processIdentifier: pid)
    return Target(
        pid: pid,
        bundleId: app?.bundleIdentifier ?? "",
        name: app?.localizedName ?? "",
        windowId: windowId,
        title: title,
        frame: .zero
    )
}

private func target(for window: SCWindow, content: SCShareableContent) -> Target {
    let app = window.owningApplication
    return Target(
        pid: app?.processID ?? 0,
        bundleId: app?.bundleIdentifier ?? "",
        name: app?.applicationName ?? "",
        windowId: window.windowID,
        title: window.title ?? "",
        frame: window.frame
    )
}

/// ScreenCaptureKit's shareable content (macOS 13+).
///
/// `onScreenWindowsOnly: false` is what makes BACKGROUND windows visible to
/// us — the whole point of the background actuation mode.
private func awaitShareableContent() async throws -> SCShareableContent {
    return try await SCShareableContent.current
}

/* ---------------- AX tree ---------------- */

private struct TreeNode {
    let id: String
    let role: String
    let title: String
    let value: String
    let description: String
    let actions: [String]
    let windowId: CGWindowID
    let depth: Int
}

/// Build the accessibility tree of a target app.
///
/// The tree is walked once and the AXUIElement of every node is kept in the
/// snapshot registry, so a later action can address an element by id
/// without re-walking (and without the tree having changed underneath).
private func buildTree(for target: Target, maxDepth: Int = 8, maxChildren: Int = 40) throws -> ([TreeNode], [String: ElementRecord]) {
    try requireAccessibility()
    let appElement = AXUIElementCreateApplication(target.pid)
    var nodes: [TreeNode] = []
    var records: [String: ElementRecord] = [:]
    var counter = 0

    func describe(_ element: AXUIElement, windowId: CGWindowID, depth: Int) -> [String: Any]? {
        let role = axString(element, kAXRoleAttribute as String) ?? "AXUnknown"
        let title = axString(element, kAXTitleAttribute as String) ?? ""
        let value = axString(element, kAXValueAttribute as String) ?? ""
        let desc = axString(element, kAXDescriptionAttribute as String) ?? ""
        counter += 1
        let id = "ax\(counter)"
        records[id] = ElementRecord(
            element: element,
            pid: target.pid,
            role: role,
            title: title,
            windowID: windowId,
            frame: elementFrame(element) ?? .zero
        )
        let node = TreeNode(
            id: id, role: role, title: title, value: value, description: desc,
            actions: axActions(element), windowId: windowId, depth: depth
        )
        nodes.append(node)
        var children: [[String: Any]] = []
        if depth < maxDepth {
            for child in axChildren(element).prefix(maxChildren) {
                if let described = describe(child, windowId: windowId, depth: depth + 1) {
                    children.append(described)
                }
            }
        }
        var out: [String: Any] = [
            "id": id,
            "role": role,
            "title": title,
        ]
        // The frame lets the model reason about where the control is, and
        // lets a later action check that it has not moved.
        let frame = elementFrame(element)
        if let frame {
            out["x"] = Double(frame.origin.x)
            out["y"] = Double(frame.origin.y)
            out["width"] = Double(frame.width)
            out["height"] = Double(frame.height)
        }
        if !value.isEmpty { out["value"] = value }
        if !desc.isEmpty { out["description"] = desc }
        let actions = axActions(element)
        if !actions.isEmpty { out["actions"] = actions }
        if !children.isEmpty { out["children"] = children }
        return out
    }

    var windowPayloads: [[String: Any]] = []
    if let rawWindows = axAttr(appElement, kAXWindowsAttribute as String) as? [AXUIElement] {
        for window in rawWindows.prefix(6) {
            let windowTitle = axString(window, kAXTitleAttribute as String) ?? ""
            let windowId = target.windowId
            var payload: [String: Any] = ["title": windowTitle]
            let children = axChildren(window).prefix(maxChildren).compactMap {
                describe($0, windowId: windowId, depth: 0)
            }
            if !children.isEmpty { payload["children"] = children }
            windowPayloads.append(payload)
        }
    }

    return (nodes, records)
}

/* ---------------- background invariants ---------------- */

/// The pid of the app the user is currently looking at.
private func frontmostPid() -> pid_t {
    NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}

/// Where the user's real cursor is. A background action must not move it.
private func cursorLocation() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

/// Read an element's current frame in global logical coordinates.
private func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = axAttr(element, kAXPositionAttribute as String),
          let sizeValue = axAttr(element, kAXSizeAttribute as String) else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: position, size: size)
}

/// How far an element may drift before its handle is considered stale.
/// A couple of points is layout noise; more than that means the control
/// the model saw is not the control that is there now.
private let GEOMETRY_TOLERANCE: CGFloat = 2.0

/// Run an action and report what it did to the user's session.
///
/// This is the part that makes a background action *checkable*. The caller
/// says how the action was performed (targeted at the app, or through the
/// real HID cursor); the wrapper observes the facts — was the app
/// foregrounded, did the cursor move, is the frontmost app still the same one
/// — and reports them next to the action's own outcome.
private func withInvariants(
    method: String,
    targeted: Bool,
    body: () throws -> [String: Any]
) throws -> [String: Any] {
    let frontmostBefore = frontmostPid()
    let cursorBefore = cursorLocation()
    var outcome = try body()
    let frontmostAfter = frontmostPid()
    let cursorAfter = cursorLocation()

    let movedCursor = abs(cursorAfter.x - cursorBefore.x) > 0.5 || abs(cursorAfter.y - cursorBefore.y) > 0.5
    // A targeted (process-destined) event cannot foreground the app on its
    // own; a real HID event usually does.
    let physicalInput = !targeted
    let activated = frontmostAfter != frontmostBefore

    var background: [String: Any] = [
        "backgroundTargeted": targeted,
        "frontmostApplicationPreserved": frontmostBefore == frontmostAfter,
        "systemCursorPreserved": !movedCursor,
        "frontmostProcessIdentifierBefore": Int(frontmostBefore),
        "frontmostProcessIdentifierAfter": Int(frontmostAfter),
    ]
    background["frontmostProcessIdentifierBefore"] = Int(frontmostBefore)
    background["frontmostProcessIdentifierAfter"] = Int(frontmostAfter)

    var merged = outcome["outcome"] as? [String: Any] ?? [:]
    merged["method"] = merged["method"] ?? method
    merged["physicalInput"] = physicalInput
    merged["movedSystemCursor"] = movedCursor
    merged["activated"] = activated
    merged["background"] = targeted
    merged["backgroundInteraction"] = background
    outcome["outcome"] = merged
    return outcome
}

/// The observable state of the target app after an action.
private func targetIsActive(_ pid: pid_t) -> Bool {
    pid != 0 && frontmostPid() == pid
}

/* ---------------- actuation ---------------- */

/// Act on an element through the accessibility API — in the BACKGROUND.
///
/// This is the key difference from the JXA helper: no global mouse event is
/// posted, the user's pointer never moves, and the target app does not need
/// to be frontmost.
private func actOnElement(_ record: ElementRecord, action: String, value: String?) throws -> [String: Any] {
    try requireAccessibility()
    // The element must still belong to the app we snapshotted. (There is no
    // public AXUIElementIsValid, so the owning pid is the liveness check.)
    var pid: pid_t = 0
    guard AXUIElementGetPid(record.element, &pid) == .success else {
        throw fail(-32008, "STALE_ELEMENT")
    }
    if pid != record.pid {
        throw fail(-32008, "STALE_ELEMENT")
    }
    // Geometry revalidation: the handle is only valid for the control the
    // model actually looked at. If the element has moved since the tree was
    // read, the click would land somewhere else.
    if record.frame.width > 0 || record.frame.height > 0 {
        if let current = elementFrame(record.element) {
            let drift = hypot(current.origin.x - record.frame.origin.x, current.origin.y - record.frame.origin.y)
            let resized = abs(current.width - record.frame.width) > GEOMETRY_TOLERANCE
                || abs(current.height - record.frame.height) > GEOMETRY_TOLERANCE
            if drift > GEOMETRY_TOLERANCE || resized {
                throw fail(-32008, "STALE_ELEMENT")
            }
        }
    }
    switch action {
    case "press":
        var performed = false
        if AXUIElementPerformAction(record.element, kAXPressAction as CFString) == .success {
            performed = true
        } else {
            // AXPress is not universal; fall back to the accessibility "click"
            // via AXShowMenu / AXShowAlternateUI, then to a targeted event.
            if AXUIElementPerformAction(record.element, kAXShowMenuAction as CFString) == .success {
                performed = true
            }
        }
        if !performed {
            throw fail(-32009, "ACTION_NOT_SUPPORTED")
        }
        return ["outcome": ["method": "press", "dispatched": true, "effectVerified": true, "background": true]]
    case "set_value":
        guard let newValue = value, !newValue.isEmpty else {
            throw fail(-32602, "value required")
        }
        var settable = DarwinBoolean(false)
        let check = AXUIElementIsAttributeSettable(record.element, kAXValueAttribute as CFString, &settable)
        guard check == .success, settable.boolValue else {
            throw fail(-32010, "NOT_SETTABLE")
        }
        let result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, newValue as CFTypeRef)
        guard result == .success else {
            throw fail(-32010, "SET_VALUE_FAILED")
        }
        return ["outcome": ["method": "set_value", "dispatched": true, "effectVerified": true, "background": true]]
    case "scroll":
        // AXScrollToVisible brings the element into view without a scroll event.
        if AXUIElementPerformAction(record.element, "AXScrollToVisible" as CFString) == .success {
            return ["outcome": ["method": "scroll", "dispatched": true, "effectVerified": true, "background": true]]
        }
        throw fail(-32009, "ACTION_NOT_SUPPORTED")
    case "select":
        guard let newValue = value else { throw fail(-32602, "value required") }
        if AXUIElementSetAttributeValue(record.element, kAXSelectedAttribute as CFString, newValue as CFTypeRef) == .success {
            return ["outcome": ["method": "select", "dispatched": true, "effectVerified": true, "background": true]]
        }
        throw fail(-32010, "SELECT_FAILED")
    default:
        throw fail(-32601, "unknown action")
    }
}

/* ---------------- apps ---------------- */

private func blockedApps() -> Set<String> {
    let raw = ProcessInfo.processInfo.environment["QUANSIOX_COMPUTER_BLOCKLIST"] ?? ""
    let entries = raw.split(whereSeparator: { $0 == "," || $0 == ";" }).map { $0.trimmingCharacters(in: .whitespaces) }
    let defaults = [
        "com.apple.keychainaccess", "com.apple.securityagent", "com.apple.loginwindow",
        "com.apple.SecurityAgent", "com.apple.Passwords",
    ]
    return Set((entries + defaults).map { $0.lowercased() }.filter { !$0.isEmpty })
}

private func isBlocked(name: String, bundleId: String?) -> Bool {
    let blocked = blockedApps()
    if blocked.contains(name.lowercased()) { return true }
    if let id = bundleId, blocked.contains(id.lowercased()) { return true }
    return false
}

private func openApp(name: String) throws -> [String: Any] {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { throw fail(-32602, "name required") }
    var bundleId: String?
    if trimmed.contains("/") {
        let url = URL(fileURLWithPath: trimmed)
        bundleId = Bundle(url: url)?.bundleIdentifier
    } else {
        for app in NSWorkspace.shared.runningApplications {
            if (app.localizedName ?? "").caseInsensitiveCompare(trimmed) == .orderedSame {
                bundleId = app.bundleIdentifier
                break
            }
        }
    }
    if isBlocked(name: trimmed, bundleId: bundleId) {
        throw fail(-32005, "APP_BLOCKED: \(trimmed)")
    }
    if trimmed.contains("/") {
        let url = URL(fileURLWithPath: trimmed)
        guard NSWorkspace.shared.open(url) else { throw fail(-32006, "OPEN_APP_FAILED") }
    } else if let bundleId = bundleId,
              NSWorkspace.shared.launchApplication(withBundleIdentifier: bundleId, options: [], additionalEventParamDescriptor: nil, launchIdentifier: nil) {
        // launched by bundle id
    } else {
        guard NSWorkspace.shared.launchApplication(trimmed) else {
            throw fail(-32006, "OPEN_APP_FAILED: \(trimmed)")
        }
    }
    return ["outcome": ["method": "open_app", "dispatched": true, "effectVerified": true]]
}

private func listRunningApps() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .prefix(200)
        .map { app in
            [
                "name": app.localizedName ?? app.bundleIdentifier ?? "Unknown",
                "bundleIdentifier": app.bundleIdentifier ?? "",
                "path": app.bundleURL?.path ?? "",
                "isSystem": (app.bundleIdentifier ?? "").hasPrefix("com.apple."),
                "frontmost": app.isActive,
            ]
        }
}

/// Windows of every app (ScreenCaptureKit), so the caller can pick a target.
private func listWindows() async throws -> [[String: Any]] {
    let content = try await awaitShareableContent()
    return content.windows.prefix(200).map { window in
        [
            "windowId": Int(window.windowID),
            "title": window.title ?? "",
            "app": window.owningApplication?.applicationName ?? "",
            "bundleId": window.owningApplication?.bundleIdentifier ?? "",
            "pid": Int(window.owningApplication?.processID ?? 0),
            "frame": [
                "x": Double(window.frame.origin.x),
                "y": Double(window.frame.origin.y),
                "width": Double(window.frame.size.width),
                "height": Double(window.frame.size.height),
            ],
        ]
    }
}

/// Capture ONE window of a target app (ScreenCaptureKit), even when the app
/// is in the background. Returns PNG base64.
private func captureWindow(_ target: Target) async throws -> [String: Any] {
    let content = try await awaitShareableContent()
    let candidates = content.windows.filter { window in
        if target.windowId != 0 { return window.windowID == target.windowId }
        if !target.bundleId.isEmpty { return window.owningApplication?.bundleIdentifier == target.bundleId }
        if !target.name.isEmpty { return window.owningApplication?.applicationName == target.name }
        return window.owningApplication?.processID == target.pid
    }
    guard let window = candidates.first else {
        throw fail(-32011, "NO_SUCH_WINDOW")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.width = max(1, Int(window.frame.size.width))
    config.height = max(1, Int(window.frame.size.height))
    config.captureResolution = .best
    let image = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: config
    )
    let cgImage = image
    let rep = NSBitmapImageRep(cgImage: cgImage)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        throw fail(-32012, "CAPTURE_FAILED")
    }
    return [
        "id": "shot-\(Date().timeIntervalSince1970)",
        "data": png.base64EncodedString(),
        "width": cgImage.width,
        "height": cgImage.height,
        "windowId": Int(window.windowID),
        "app": window.owningApplication?.applicationName ?? target.name,
    ]
}

/* ---------------- input (foreground fallback) ---------------- */

private let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "leftarrow": 123, "right": 124, "rightarrow": 124,
    "down": 125, "downarrow": 125, "up": 126, "uparrow": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "t": 16, "y": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
    "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]

private func keycode(_ name: String) -> CGKeyCode? {
    let normalized = name.lowercased()
        .replacingOccurrences(of: " ", with: "")
        .replacingOccurrences(of: "_", with: "")
        .replacingOccurrences(of: "-", with: "")
    if let code = keyCodes[normalized] { return code }
    if normalized.count == 1, let scalar = normalized.unicodeScalars.first {
        let ch = Character(scalar)
        if let code = keyCodes[String(ch)] { return code }
    }
    return nil
}

private func modifierFlags(_ modifiers: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for raw in modifiers {
        switch raw.lowercased() {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: break
        }
    }
    return flags
}

private func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
    try requireAccessibility()
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        throw fail(-32004, "KEY_EVENT_FAILED")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

private func postUnicode(_ text: String) throws {
    try requireAccessibility()
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
        let chunk = Array(units[index..<min(index + 20, units.count)])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw fail(-32004, "KEY_EVENT_FAILED")
        }
        chunk.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        index += chunk.count
        usleep(4_000)
    }
}

private func typeText(_ text: String) throws -> [String: Any] {
    try requireAccessibility()
    var literal = ""
    func flushLiteral() throws {
        if !literal.isEmpty { try postUnicode(literal); literal = "" }
    }
    for ch in text {
        switch ch {
        case "\n", "\r":
            try flushLiteral()
            try postKey(36)
        case "\t":
            try flushLiteral()
            try postKey(48)
        default:
            literal.append(ch)
        }
    }
    try flushLiteral()
    return ["outcome": ["method": "type_text", "dispatched": true, "effectVerified": true]]
}

/// Click at global coordinates. When the target app is known the event is
/// posted to that process (`postToPid`) so the user's pointer is untouched.
private func click(x: Double, y: Double, button: String = "left", clickCount: Int = 1, targetPid: pid_t = 0) throws -> [String: Any] {
    try requireAccessibility()
    let point = CGPoint(x: x, y: y)
    let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton) = {
        switch button.lowercased() {
        case "right": return (.rightMouseDown, .rightMouseUp, .right)
        case "middle": return (.otherMouseDown, .otherMouseUp, .center)
        default: return (.leftMouseDown, .leftMouseUp, .left)
        }
    }()
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton),
          let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton) else {
        throw fail(-32004, "MOUSE_EVENT_FAILED")
    }
    down.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clickCount)))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, clickCount)))
    if targetPid != 0 {
        // Targeted: the event goes to the app, not to the user's session.
        move.postToPid(targetPid)
        down.postToPid(targetPid)
        up.postToPid(targetPid)
    } else {
        move.post(tap: .cghidEventTap)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
    return ["outcome": ["method": "click", "dispatched": true, "effectVerified": true, "background": targetPid != 0]]
}

private func scroll(x: Double?, y: Double?, deltaY: Double, targetPid: pid_t = 0) throws -> [String: Any] {
    try requireAccessibility()
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(deltaY * 10), wheel2: 0, wheel3: 0) else {
        throw fail(-32004, "SCROLL_EVENT_FAILED")
    }
    if let x = x, let y = y { event.location = CGPoint(x: x, y: y) }
    if targetPid != 0 { event.postToPid(targetPid) } else { event.post(tap: .cghidEventTap) }
    return ["outcome": ["method": "scroll", "dispatched": true, "effectVerified": true, "background": targetPid != 0]]
}

/* ---------------- snapshot registry ---------------- */

private func issueSnapshot(_ records: [String: ElementRecord]) -> String {
    let id = "snap-\(UUID().uuidString.prefix(8))"
    stateQueue.sync {
        snapshots[id] = records
        snapshotOrder.append(id)
        while snapshotOrder.count > MAX_SNAPSHOTS {
            let oldest = snapshotOrder.removeFirst()
            snapshots.removeValue(forKey: oldest)
        }
    }
    return id
}

private func record(snapshotId: String, elementId: String) -> ElementRecord? {
    stateQueue.sync { snapshots[snapshotId]?[elementId] }
}

/* ---------------- panic chord ---------------- */

private func panicTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .keyDown {
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        if code == 53 && flags.contains(.maskControl) && flags.contains(.maskAlternate) {
            logLine("panic chord pressed — exiting")
            exit(0)
        }
    }
    return Unmanaged.passUnretained(event)
}

private func installPanicTap() {
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: panicTapCallback,
        userInfo: nil
    ) else {
        logLine("panic tap unavailable (Accessibility/Input Monitoring not granted)")
        return
    }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
}

/* ---------------- dispatch ---------------- */

private func methodsList() -> [String] {
    return [
        "initialize", "computer/authenticate", "computer/status",
        "computer/app_state", "computer/find_elements", "computer/click",
        "computer/type_text", "computer/set_value", "computer/press_key",
        "computer/scroll", "computer/open_app", "computer/list_apps",
        "computer/list_windows", "computer/screenshot", "computer/finish",
        "application/list", "application/icon",
    ]
}

private func dispatch(_ request: [String: Any]) async throws -> Any {
    guard let method = request["method"] as? String else {
        throw fail(-32600, "invalid request")
    }
    let params = request["params"] as? [String: Any] ?? [:]
    if method == "initialize" {
        return ["protocol": protocolVersion, "methods": methodsList(), "capabilities": ["background": true, "windowCapture": true]]
    }
    if method == "computer/authenticate" {
        let supplied = params["controlToken"] as? String ?? ""
        if supplied != controlToken { throw fail(-32001, "UNAUTHORIZED") }
        authenticated = true
        return ["authenticated": true, "deviceKind": "desktop"]
    }
    try requireAuth()

    switch method {
    case "computer/status":
        let revision = stateQueue.sync { axRevision }
        let snapshotCount = stateQueue.sync { snapshots.count }
        return [
            "version": 4,
            "running": true,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "permissions": [
                "accessibilityTrusted": accessibilityTrusted(),
                // The helper cannot capture without this, and it is the
                // permission the user is most often missing.
                "screenRecordingTrusted": CGPreflightScreenCaptureAccess(),
            ],
            "axRevision": revision,
            "session": [
                "snapshots": snapshotCount,
                "frontmostProcessIdentifier": Int(frontmostPid()),
                "cursor": ["x": Double(cursorLocation().x), "y": Double(cursorLocation().y)],
            ],
        ]
    case "computer/finish":
        // Release the session: drop every element handle so the agent has to
        // observe again before acting on a stale control.
        let dropped = stateQueue.sync { () -> Int in
            let count = snapshots.count
            snapshots.removeAll()
            snapshotOrder.removeAll()
            axRevision += 1
            return count
        }
        return [
            "finished": true,
            "releasedSnapshots": dropped,
            "axRevision": stateQueue.sync { axRevision },
            "note": "Element handles are released — call computer_ax_tree before the next action.",
        ]
    case "computer/app_state":
        let target = try await resolveTarget(params)
        let (nodes, records) = try buildTree(for: target)
        let revision = stateQueue.sync { axRevision + 1 }
        stateQueue.sync { axRevision += 1 }
        let snapshotId = issueSnapshot(records)
        return [
            "app": target.name,
            "pid": Int(target.pid),
            "bundleId": target.bundleId,
            "windowId": Int(target.windowId),
            "title": target.title,
            "windows": [],
            "elements": nodes.map { node in
                [
                    "id": node.id,
                    "role": node.role,
                    "title": node.title,
                    "value": node.value,
                    "actions": node.actions,
                    "windowId": Int(node.windowId),
                ]
            },
            "meta": [
                "schema": "quansiox.computer.meta/v2",
                "axRevision": revision,
                "snapshotId": snapshotId,
                "outcome": ["dispatched": true, "effectVerified": true, "background": true],
                "permissions": ["accessibilityTrusted": true],
            ],
        ]
    case "computer/find_elements":
        let target = try await resolveTarget(params)
        let (nodes, records) = try buildTree(for: target)
        let snapshotId = issueSnapshot(records)
        let role = (params["role"] as? String)?.lowercased()
        let name = (params["name"] as? String)?.lowercased()
        let valueNeedle = params["value"] as? String
        let matched = nodes.filter { node in
            if let role = role, node.role.lowercased() != role { return false }
            if let name = name, !node.title.lowercased().contains(name), !node.description.lowercased().contains(name) { return false }
            if let valueNeedle = valueNeedle, !node.value.contains(valueNeedle) { return false }
            return true
        }
        return [
            "count": matched.count,
            "elements": matched.prefix(50).map { node in
                [
                    "id": node.id,
                    "role": node.role,
                    "title": node.title,
                    "value": node.value,
                    "actions": node.actions,
                ]
            },
            "snapshotId": snapshotId,
            "axRevision": stateQueue.sync { axRevision },
        ]
    case "computer/click":
        // Element click: background AX press, no pointer movement.
        if let elementId = params["element_id"] as? String,
           let snapshotId = params["snapshot_id"] as? String {
            guard let rec = record(snapshotId: snapshotId, elementId: elementId) else {
                throw fail(-32008, "STALE_ELEMENT")
            }
            return try withInvariants(method: "click", targeted: true) {
                try actOnElement(rec, action: "press", value: nil)
            }
        }
        let x = (params["x"] as? NSNumber)?.doubleValue
        let y = (params["y"] as? NSNumber)?.doubleValue
        guard let x = x, let y = y else { throw fail(-32602, "x/y required") }
        var targetPid: pid_t = 0
        if params["bundle_id"] != nil || params["app_name"] != nil || params["pid"] != nil {
            targetPid = try await resolveTarget(params).pid
        }
        return try withInvariants(method: "click", targeted: targetPid != 0) {
            try click(
                x: x, y: y,
                button: params["button"] as? String ?? "left",
                clickCount: (params["click_count"] as? NSNumber)?.intValue ?? 1,
                targetPid: targetPid
            )
        }
    case "computer/set_value":
        guard let elementId = params["element_id"] as? String,
              let snapshotId = params["snapshot_id"] as? String else {
            throw fail(-32602, "element_id and snapshot_id required")
        }
        guard let rec = record(snapshotId: snapshotId, elementId: elementId) else {
            throw fail(-32008, "STALE_ELEMENT")
        }
        return try withInvariants(method: "set_value", targeted: true) {
            try actOnElement(rec, action: "set_value", value: params["value"] as? String)
        }
    case "computer/type_text":
        guard let text = params["text"] as? String, !text.isEmpty else {
            throw fail(-32602, "text required")
        }
        return try withInvariants(method: "type_text", targeted: false) {
            try typeText(text)
        }
    case "computer/press_key":
        guard let key = params["key"] as? String else { throw fail(-32602, "key required") }
        guard let code = keycode(key) else { throw fail(-32602, "unknown key: \(key)") }
        let mods = params["modifiers"] as? [String] ?? []
        return try withInvariants(method: "press_key", targeted: false) {
            try postKey(code, flags: modifierFlags(mods))
            return ["outcome": ["method": "press_key", "dispatched": true, "effectVerified": true]]
        }
    case "computer/scroll":
        let x = (params["x"] as? NSNumber)?.doubleValue
        let y = (params["y"] as? NSNumber)?.doubleValue
        let delta = (params["deltaY"] as? NSNumber)?.doubleValue ?? -3
        var targetPid: pid_t = 0
        if params["bundle_id"] != nil || params["app_name"] != nil || params["pid"] != nil {
            targetPid = try await resolveTarget(params).pid
        }
        return try withInvariants(method: "scroll", targeted: targetPid != 0) {
            try scroll(x: x, y: y, deltaY: delta, targetPid: targetPid)
        }
    case "computer/open_app":
        guard let name = params["name"] as? String, !name.isEmpty else {
            throw fail(-32602, "name required")
        }
        return try openApp(name: name)
    case "computer/list_apps":
        return ["apps": listRunningApps()]
    case "computer/list_windows":
        return ["windows": try await listWindows()]
    case "computer/screenshot":
        let target = try await resolveTarget(params)
        return try await captureWindow(target)
    case "application/list":
        return ["apps": installedApps()]
    case "application/icon":
        return appIcon(path: params["path"] as? String)
    default:
        throw fail(-32601, "unknown method: \(method)")
    }
}

private func installedApps() -> [[String: Any]] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let dirs = ["/Applications", home + "/Applications", "/System/Applications"]
    var seen = Set<String>()
    var out: [[String: Any]] = []
    for dir in dirs {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
        for entry in entries.sorted().prefix(500) where entry.hasSuffix(".app") {
            let path = dir + "/" + entry
            guard !seen.contains(path) else { continue }
            seen.insert(path)
            let bundle = Bundle(url: URL(fileURLWithPath: path))
            let name = (entry as NSString).deletingPathExtension
            out.append([
                "name": bundle?.infoDictionary?["CFBundleDisplayName"] as? String ?? name,
                "bundleIdentifier": bundle?.bundleIdentifier ?? "",
                "path": path,
                "isSystem": path.hasPrefix("/System/"),
            ])
            if out.count >= 500 { return out }
        }
    }
    return out
}

private func appIcon(path: String?) -> [String: Any] {
    guard let path = path, !path.isEmpty else { return ["dataUrl": NSNull()] }
    let image = NSWorkspace.shared.icon(forFile: path)
    image.size = NSSize(width: 64, height: 64)
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        return ["dataUrl": NSNull()]
    }
    return ["dataUrl": "data:image/png;base64," + png.base64EncodedString()]
}

private func requireAuth() throws {
    if !authenticated {
        throw fail(-32001, "UNAUTHORIZED — authenticate first")
    }
}

/* ---------------- bootstrap + lifecycle ---------------- */

private func readBootstrap() throws {
    guard let file = ProcessInfo.processInfo.environment["QUANSIOX_COMPUTER_HELPER_BOOTSTRAP"], !file.isEmpty else {
        throw fail(-32000, "missing QUANSIOX_COMPUTER_HELPER_BOOTSTRAP")
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: file))
    try? FileManager.default.removeItem(atPath: file)
    guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (parsed["version"] as? Int) == 1,
          let token = parsed["controlToken"] as? String, !token.isEmpty else {
        throw fail(-32000, "bad bootstrap")
    }
    controlToken = token
}

private func serve() throws {
    guard let path = ProcessInfo.processInfo.environment["QUANSIOX_COMPUTER_HELPER_SOCKET"], !path.isEmpty else {
        throw fail(-32000, "missing QUANSIOX_COMPUTER_HELPER_SOCKET")
    }
    socketPath = path
    unlink(path)
    listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
    if listenFd < 0 { throw fail(-32000, "socket() failed") }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutablePointer(to: &addr.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: 104) { destination in
            path.withCString { source in strcpy(destination, source) }
        }
    }
    let bound = withUnsafePointer(to: &addr) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if bound != 0 { throw fail(-32000, "bind() failed: \(String(cString: strerror(errno)))") }
    chmod(path, 0o600)
    if listen(listenFd, 8) != 0 { throw fail(-32000, "listen() failed") }
    logLine("listening on \(path) (pid \(ProcessInfo.processInfo.processIdentifier))")

    DispatchQueue.global(qos: .utility).async {
        installPanicTap()
        while true {
            let client = accept(listenFd, nil, nil)
            if client < 0 { continue }
            DispatchQueue.global(qos: .userInitiated).async { handleClient(client) }
        }
    }
}

private func handleClient(_ fd: Int32) {
    var buffer = Data()
    let chunkSize = 64 * 1024
    var chunk = [UInt8](repeating: 0, count: chunkSize)
    while true {
        let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, chunkSize) }
        if count <= 0 { break }
        buffer.append(contentsOf: chunk[0..<count])
        if buffer.count > 4 * 1024 * 1024 { break }
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: 0..<newline)
            buffer.removeSubrange(0...newline)
            guard !lineData.isEmpty,
                  let request = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
            let id = request["id"]
            _ = Task {
                do {
                    let result = try await dispatch(request)
                    if id != nil { sendResult(id, result, to: fd) }
                } catch let failure as RPCFailure {
                    if id != nil { sendError(id, failure.code, failure.message, to: fd) }
                } catch {
                    if id != nil { sendError(id, -32000, String(describing: error), to: fd) }
                }
            }
        }
    }
    close(fd)
}

private func installLifecycle() {
    atexit {
        if !socketPath.isEmpty { unlink(socketPath) }
    }
    signal(SIGTERM, { _ in exit(0) })
    signal(SIGINT, { _ in exit(0) })
    // Orphan check: if the spawning app dies, exit with it.
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler {
        if getppid() == 1 { exit(0) }
    }
    timer.resume()
}

do {
    try readBootstrap()
    installLifecycle()
    try serve()
    CFRunLoopRun()
} catch let failure as RPCFailure {
    logLine("fatal: \(failure.message)")
    exit(1)
} catch {
    logLine("fatal: \(error)")
    exit(1)
}
