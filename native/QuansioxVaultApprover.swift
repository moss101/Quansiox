// Quansiox vault approver — a Touch ID / passcode gate for secret release.
//
// The vault may hold real credentials. Before any secret leaves the main
// process, the user must approve it with a biometric. This tiny helper exists
// so the approval happens in a separate, Apple-signed process with its own
// reason string, exactly like macOS's own keychain prompts.
//
//   quansiox-vault-approver "fill the login form for example.com"
//
// Exit codes:
//   0  approved
//   1  declined by the user
//   2  the machine cannot prompt for a *fresh* biometric — the caller decides
//      the fallback (no biometric enrolled, or the OS would have authenticated
//      without a human present)
//   3  no interactive console session — the caller decides the fallback
//   4  the prompt was shown but never answered in time (a refusal)
//
// The helper never sees the secret — it only signs off on the request.
//
// `--self-test` runs the decision table without needing a biometric. It exists
// so the refusal paths are provable on a machine with no Touch ID and no
// human present; `test/native-helper.js` drives it.
import Foundation
import LocalAuthentication
import CoreGraphics

private func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(("quansiox-vault-approver: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

// ---------------------------------------------------------------------------
// The decision table, as a pure function so it can be tested.
// ---------------------------------------------------------------------------

/// What the OS told us when we asked "could you authenticate without a human?".
enum ProbeOutcome {
    /// The OS was willing to authenticate with no interaction — it would have
    /// reused an earlier unlock. This is NOT an approval.
    case reusable
    /// The OS requires a real interaction; the policy was prepared fine.
    case interactionRequired
    /// The policy could not be prepared at all (no biometric, lockout, …).
    case unavailable(code: Int)
}

/// What the interactive evaluation ended up doing.
enum EvaluationOutcome {
    case approved
    case declined(code: Int)
    case timedOut
}

/// Decide the exit code. Pure: no I/O, no globals.
func decide(probe: ProbeOutcome, biometricEnrolled: Bool, evaluation: EvaluationOutcome) -> (code: Int32, message: String) {
    if !biometricEnrolled {
        return (2, "no biometric is enrolled — the caller decides the fallback")
    }
    switch probe {
    case .reusable:
        return (2, "the operating system would authenticate without a human present (a reused unlock state) — refusing")
    case .unavailable(let code):
        return (2, "the biometric policy could not be prepared (code \(code))")
    case .interactionRequired:
        break
    }
    switch evaluation {
    case .approved:
        return (0, "approved")
    case .timedOut:
        return (4, "the prompt was not answered in time")
    case .declined(let code):
        switch LAError.Code(rawValue: code) {
        case .some(.userCancel), .some(.appCancel), .some(.systemCancel), .some(.biometryLockout):
            return (1, "declined")
        case .some(.biometryNotAvailable), .some(.biometryNotEnrolled), .some(.passcodeNotSet):
            return (2, "no biometric hardware")
        default:
            return (3, "the prompt could not be presented")
        }
    }
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------
if CommandLine.arguments.contains("--self-test") {
    let interactionRequired = ProbeOutcome.interactionRequired
    let scenarios: [(String, ProbeOutcome, Bool, EvaluationOutcome, Int32)] = [
        ("a human matched", interactionRequired, true, .approved, 0),
        ("the user cancelled", interactionRequired, true, .declined(code: LAError.Code.userCancel.rawValue), 1),
        ("the prompt timed out", interactionRequired, true, .timedOut, 4),
        ("no biometric enrolled", interactionRequired, false, .approved, 2),
        ("the os would reuse the unlock", .reusable, true, .approved, 2),
        ("the policy could not be prepared", .unavailable(code: -7), true, .approved, 2),
        ("a biometry error is not an approval", interactionRequired, true, .declined(code: LAError.Code.biometryNotEnrolled.rawValue), 2),
    ]
    var failures = 0
    for (name, probe, enrolled, evaluation, expected) in scenarios {
        let verdict = decide(probe: probe, biometricEnrolled: enrolled, evaluation: evaluation)
        let ok = verdict.code == expected
        if !ok { failures += 1 }
        let status = ok ? "PASS" : "FAIL"
        print("\(status) \(name): exit=\(verdict.code) (expected \(expected)) — \(verdict.message)")
    }
    if failures == 0 {
        print("self-test OK: \(scenarios.count) scenarios")
        exit(0)
    }
    print("self-test FAILED: \(failures) of \(scenarios.count) scenarios")
    exit(1)
}

// ---------------------------------------------------------------------------
// Live path
// ---------------------------------------------------------------------------
let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail(2, "usage: quansiox-vault-approver [--timeout seconds] <reason>")
}

var timeoutSeconds: Double = 60
var reasonParts: [String] = []
var index = 1
while index < arguments.count {
    let argument = arguments[index]
    if argument == "--timeout", index + 1 < arguments.count {
        timeoutSeconds = Double(arguments[index + 1]) ?? 60
        index += 2
        continue
    }
    reasonParts.append(argument)
    index += 1
}
let reason = reasonParts.joined(separator: " ")

// A prompt can only be shown in an interactive console session. When there
// is none (a background daemon, a CI run, an SSH session), we say so
// instead of hanging forever.
func hasConsoleSession() -> Bool {
    guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let onConsole = dictionary[kCGSessionOnConsoleKey as String] as? Bool {
        return onConsole
    }
    return false
}

if !hasConsoleSession() {
    fail(3, "no interactive console session")
}

let context = LAContext()
context.localizedCancelTitle = "Cancel"
context.localizedFallbackTitle = "Use Password"

var evaluationError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &evaluationError) else {
    // No biometric hardware and no passcode: the caller decides the
    // fallback. This is NOT a decline.
    fail(2, evaluationError?.localizedDescription ?? "cannot evaluate the device owner policy")
}

let biometricEnrolled = context.biometryType != .none

// ---------------------------------------------------------------------------
// Freshness probe.
//
// `kCGSessionOnConsoleKey` tells us the *session* is attached to the console,
// not that this process can show UI, and it does not tell us that a human is
// present. On a machine whose owner has recently unlocked it, macOS is
// willing to satisfy a biometric evaluation *without presenting anything* —
// it reuses the existing authentication. That makes a naive
// `evaluatePolicy(...) -> success` indistinguishable from "a person just
// approved this", and it turns the helper into a rubber stamp.
//
// `LAContext.interactionNotAllowed` is the public way to ask the opposite
// question: "could you satisfy this WITHOUT a human?". If the answer is yes,
// the operating system is about to reuse an earlier authentication and we
// must not report approval for this request — so we refuse and let the
// caller fall back to its own in-app approval.
//
// If the answer is no, macOS has told us a real interaction is required, and
// the interactive evaluation below can only succeed because a person did it.
// ---------------------------------------------------------------------------
func probeWithoutInteraction() -> ProbeOutcome {
    let probe = LAContext()
    probe.interactionNotAllowed = true
    let done = DispatchSemaphore(value: 0)
    var succeeded = false
    var code = 0
    probe.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "authorisation probe") { success, error in
        succeeded = success
        code = (error as NSError?)?.code ?? 0
        done.signal()
    }
    _ = done.wait(timeout: .now() + 10)
    if succeeded { return .reusable }
    switch LAError.Code(rawValue: code) {
    case .some(.userCancel), .some(.biometryNotAvailable), .some(.biometryNotEnrolled), .some(.biometryLockout):
        return .interactionRequired
    case .some(.appCancel), .some(.systemCancel):
        return .interactionRequired
    default:
        // -1004 (LAError.Code.userCancel on newer systems reports "User
        // interaction required") and anything we do not recognise means the
        // policy was refused, not satisfied.
        if code == -1004 { return .interactionRequired }
        return .unavailable(code: code)
    }
}

let probe = probeWithoutInteraction()
if case .unavailable(let code) = probe, code != -1004 {
    let verdict = decide(probe: probe, biometricEnrolled: biometricEnrolled, evaluation: .declined(code: code))
    fail(verdict.code, verdict.message)
}

let semaphore = DispatchSemaphore(value: 0)
var approved = false
var failureDescription: String?
var failureCode: Int?

context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
    approved = success
    if !success, let error = error as NSError? {
        failureDescription = error.localizedDescription
        failureCode = error.code
    }
    semaphore.signal()
}

// A prompt that is never answered must not block the vault forever.
let deadline = DispatchTime.now() + timeoutSeconds
if semaphore.wait(timeout: deadline) == .timedOut {
    let verdict = decide(probe: probe, biometricEnrolled: biometricEnrolled, evaluation: .timedOut)
    fail(verdict.code, verdict.message)
}

let evaluation: EvaluationOutcome = approved
    ? .approved
    : .declined(code: failureCode ?? LAError.Code.userCancel.rawValue)

let verdict = decide(probe: probe, biometricEnrolled: biometricEnrolled, evaluation: evaluation)
if verdict.code == 0 { exit(0) }
fail(verdict.code, failureDescription ?? verdict.message)
