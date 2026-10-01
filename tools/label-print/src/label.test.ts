import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SignedEvent } from "@mohar/contracts";
import {
  combineScannedPair,
  encodeSeamQr,
  generateKeypair,
  generateSeamLabel,
  parseSeamQr,
  seamLabelMatches,
  verifyBodySignature,
} from "@mohar/crypto-core";
import { groupSeamId, qrMatrix, renderLabelSvg, MODULE_MM } from "./label.js";
import { buildSealEvent, makeLabel, type PacketInfo } from "./seal.js";

/**
 * ── The printed label, read back ─────────────────────────────────────────────
 *
 * The codes are drawn, turned into pixels, and decoded by jsQR - the decoder
 * the control room's scanner uses - rather than compared as strings. What is
 * tested is what a camera would get off the label.
 */

// jsqr is a CommonJS bundle whose export is the decode function itself.
const jsQR = createRequire(import.meta.url)("jsqr") as typeof import("jsqr").default;

const HOST = "https://mohar.example";

/** Rasterise a module grid the way a camera sees it: 4 px a module, white border. */
function scan(text: string): string {
  const m = qrMatrix(text);
  const scale = 4;
  const quiet = 4;
  const side = (m.size + 2 * quiet) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (!m.dark(x, y)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
          px[i] = 0;
          px[i + 1] = 0;
          px[i + 2] = 0;
        }
      }
    }
  }
  const decoded = jsQR(px, side, side);
  assert.ok(decoded, "the code did not decode");
  return decoded.data;
}

const packet: PacketInfo = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  examId: "aaaaaaaa-0000-4000-8000-000000000001",
  centreId: "cccccccc-0000-4000-8000-000000000001",
  centreCode: "JPR-014",
  copies: 300,
  sealSerial: "PKT-JPR-0091",
};

test("scanning both printed codes rebuilds a secret that satisfies the commitment", () => {
  const label = generateSeamLabel();
  const a = parseSeamQr(scan(encodeSeamQr(HOST, "A", label.seamId, label.shareA)));
  const b = parseSeamQr(scan(encodeSeamQr(HOST, "B", label.seamId, label.shareB)));
  const { seamId, seamSecret } = combineScannedPair(b, a);
  assert.equal(seamId, label.seamId);
  assert.equal(seamLabelMatches(seamId, seamSecret, label.commitment), true);
});

test("one code alone does not verify", () => {
  const label = generateSeamLabel();
  const a = parseSeamQr(scan(encodeSeamQr(HOST, "A", label.seamId, label.shareA)));
  assert.throws(() => combineScannedPair(a, a), /scanned twice/);
  assert.equal(seamLabelMatches(label.seamId, a.share, label.commitment), false);
});

test("a code from another packet's label does not complete this one", () => {
  const mine = generateSeamLabel();
  const other = generateSeamLabel();
  const a = parseSeamQr(scan(encodeSeamQr(HOST, "A", mine.seamId, mine.shareA)));
  const b = parseSeamQr(scan(encodeSeamQr(HOST, "B", other.seamId, other.shareB)));
  assert.throws(() => combineScannedPair(a, b), /different seam ids/);
});

test("the codes are level L and fit the label at half-millimetre modules", () => {
  const label = generateSeamLabel();
  const art = renderLabelSvg({
    seamId: label.seamId,
    urlA: encodeSeamQr(HOST, "A", label.seamId, label.shareA),
    urlB: encodeSeamQr(HOST, "B", label.seamId, label.shareB),
    packetSerial: "PKT-JPR-0091",
    copies: 1,
  });
  assert.equal(MODULE_MM, 0.5);
  assert.ok(art.qrVersion <= 5, `version ${art.qrVersion}`);
  assert.ok(art.widthMm <= 60, `${art.widthMm} mm wide`);
  assert.match(art.svg, new RegExp(`width="${art.widthMm}mm"`));
});

test("the label prints the seam id in groups and the packet serial", () => {
  const { art, pending } = makeLabel(packet, { verifyHost: HOST, labelsPerPacket: 1 });
  assert.ok(art.svg.includes(groupSeamId(pending.seamId)));
  assert.ok(art.svg.includes("SERIAL PKT-JPR-0091"));
  assert.equal((art.svg.match(/<path /g) ?? []).length, 2);
});

test("two labels per packet are two copies of the same codes", () => {
  const { art } = makeLabel(packet, { verifyHost: HOST, labelsPerPacket: 2 });
  const paths = [...art.svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(paths.length, 4);
  // Same modules, drawn lower down the sheet: as many dark modules in each copy.
  const count = (d: string) => (d.match(/M/g) ?? []).length;
  assert.equal(count(paths[0]!), count(paths[2]!));
  assert.equal(count(paths[1]!), count(paths[3]!));
});

test("what is kept after printing holds the commitment and no secret", () => {
  const { pending } = makeLabel(packet, { verifyHost: HOST, labelsPerPacket: 1 });
  assert.deepEqual(Object.keys(pending).sort(), [
    "labelCommitment",
    "labelsPerPacket",
    "packageId",
    "packetSerial",
    "printedAt",
    "seamId",
  ]);
  assert.match(pending.labelCommitment, /^[0-9a-f]{64}$/);
});

test("a serial other than the planned one is refused before anything is printed", () => {
  assert.throws(
    () => makeLabel(packet, { verifyHost: HOST, labelsPerPacket: 1, packetSerial: "PKT-JPR-9999" }),
    /planned for this package is PKT-JPR-0091/,
  );
});

test("the sealing event is a valid SEAL_APPLIED signed by the device", () => {
  const { pending } = makeLabel(packet, { verifyHost: HOST, labelsPerPacket: 2 });
  const kp = generateKeypair();
  const signed = buildSealEvent(
    packet,
    pending,
    { deviceId: "dddddddd-0000-4000-8000-000000000001", privateKeyHex: kp.privateKeyHex },
    { photoSha256: "ab".repeat(32), now: new Date("2026-09-27T09:00:00.000Z") },
  );
  const parsed = SignedEvent.safeParse(signed);
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  assert.equal(signed.body.kind, "SEAL_APPLIED");
  assert.equal(verifyBodySignature(signed.body, signed.deviceSig, kp.publicKeyHex), true);

  const payload = signed.body.payload as Record<string, unknown>;
  assert.equal(payload["labelCommitment"], pending.labelCommitment);
  assert.equal(payload["labelsPerPacket"], 2);
  assert.equal(payload["paperCount"], 300);
  // Nothing optional is written as null, and no secret is in the event.
  assert.equal(JSON.stringify(signed).includes("null"), false);
  assert.equal("seamSecret" in payload || "shareA" in payload || "shareB" in payload, false);
});
