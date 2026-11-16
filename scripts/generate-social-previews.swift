// Run from the repository root on macOS:
// node --experimental-strip-types --input-type=module -e \
//   "import {previews} from './lib/social-preview.ts'; console.log(JSON.stringify(previews))" \
//   | swift scripts/generate-social-previews.swift
// Uses native text/vector drawing. No remote assets, credentials or live data.
import AppKit
import Foundation

struct Preview: Decodable {
    let path: String
    let lines: [String]
    let detail: String
    let footer: String
}
let data = FileHandle.standardInput.readDataToEndOfFile()
let previews = try JSONDecoder().decode([String: Preview].self, from: data)
let target = URL(fileURLWithPath: "public/images/social", isDirectory: true)
try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
let ink = NSColor(calibratedRed: 0.13, green: 0.16, blue: 0.20, alpha: 1)
let accent = NSColor(calibratedRed: 0.68, green: 0.21, blue: 0.17, alpha: 1)
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor) {
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
    let string = NSAttributedString(string: value, attributes: attrs)
    precondition(string.size().width <= 1064, "Text exceeds safe card width: \(value)")
    string.draw(at: NSPoint(x: x, y: y))
}
for (key, p) in previews.sorted(by: { $0.key < $1.key }) {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1200, pixelsHigh: 630, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSColor(calibratedRed: 0.97, green: 0.96, blue: 0.93, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: 1200, height: 630).fill()
    accent.setFill(); NSRect(x: 0, y: 616, width: 1200, height: 14).fill()
    text("UAIN  /  UNITED AI NETWORK", 68, 530, 22, .semibold, accent)
    text("PUBLIC RESEARCH PILOT", 68, 479, 18, .medium, ink)
    for (i, line) in p.lines.enumerated() { text(line, 64, 358 - CGFloat(i) * 86, 76, .bold, ink) }
    text(p.detail, 68, 190, 32, .medium, ink)
    NSColor(calibratedWhite: 0.78, alpha: 1).setFill()
    NSRect(x: 68, y: 151, width: 1064, height: 1).fill()
    text(p.footer, 68, 103, 23, .regular, ink)
    text("uain.global" + p.path, 68, 48, 22, .medium, accent)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: target.appendingPathComponent(key + ".png"))
    print("Rendered \(key): 1200×630")
}
