import Foundation
import Vision
import AppKit
import ImageIO

// QuansioxVision — local image text recognition.
//
// The Vision framework is on every Mac and needs no model download and no
// network, so the OCR path stays local and private. The helper is a
// one-shot command (not a socket like the computer helper) because OCR is
// a request/response operation with no long-lived state.
//
//   QuansioxVision ocr <image-path> [--json]
//     → { "ok": true, "width": w, "height": h,
//         "blocks": [ { "text": …, "x": …, "y": …, "width": …, "height": …,
//                       "confidence": … } ] }
//
// The bounding boxes are in pixels, top-left origin — the same space the
// design surface marks regions in.
//
// Exit codes: 0 success, 2 usage error, 3 unreadable image, 4 no text found.

struct Block: Encodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Double
}

struct Result: Encodable {
    let ok: Bool
    let width: Int
    let height: Int
    let blocks: [Block]
    let error: String?
}

func fail(_ message: String, code: Int32) -> Never {
    let result = Result(ok: false, width: 0, height: 0, blocks: [], error: message)
    if let data = try? JSONEncoder().encode(result),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"error\":\"\(message)\"}")
    }
    exit(code)
}

let arguments = CommandLine.arguments
if arguments.count < 2 {
    fail("usage: QuansioxVision ocr <image-path>", code: 2)
}
if arguments[1] != "ocr" {
    fail("unknown command: \(arguments[1])", code: 2)
}
if arguments.count < 3 {
    fail("ocr needs an image path", code: 2)
}

let path = arguments[2]
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("cannot read image: \(path)", code: 3)
}

// Normalise into a plain sRGB bitmap before recognition.
//
// Two things upset Vision and neither is the user's fault:
//   - a **transparent background** (a PDF render keeps its alpha, so the
//     background is transparent rather than white) — the text then sits on
//     nothing and recognition returns nothing;
//   - an unusual **colour space** (Display P3 from some renderers).
//
// Redrawing the image over an opaque white background in an sRGB context
// removes both surprises, and costs one blit.
let width = decoded.width
let height = decoded.height
var normalized: CGImage? = nil
if let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) {
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.draw(decoded, in: CGRect(x: 0, y: 0, width: width, height: height))
    normalized = context.makeImage()
}
let cgImage = normalized ?? decoded

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US"]
// Small text is common in screenshots and UI captures; the default floor
// rejects it.
if #available(macOS 13.0, *) {
    request.minimumTextHeight = 0.005
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("recognition failed: \(error.localizedDescription)", code: 4)
}

var blocks: [Block] = []
if let observations = request.results {
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        blocks.append(Block(
            text: candidate.string,
            // Vision's origin is bottom-left; convert to a top-left origin.
            x: Double(box.origin.x * Double(cgImage.width)),
            y: Double((1.0 - box.origin.y - box.height) * Double(cgImage.height)),
            width: Double(box.width * Double(cgImage.width)),
            height: Double(box.height * Double(cgImage.height)),
            confidence: Double(candidate.confidence)
        ))
    }
}

if blocks.isEmpty {
    fail("no text found", code: 4)
}

let result = Result(
    ok: true,
    width: cgImage.width,
    height: cgImage.height,
    blocks: blocks.sorted { $0.y < $1.y },
    error: nil
)
if let data = try? JSONEncoder().encode(result), let text = String(data: data, encoding: .utf8) {
    print(text)
    exit(0)
}
fail("could not encode the result", code: 4)
