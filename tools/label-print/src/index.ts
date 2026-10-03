#!/usr/bin/env node
/**
 * Print a packet's seam label, then record the sealing.
 *
 *   node tools/label-print/dist/index.js print --package <id> [--labels 1|2] [--serial PKT-…]
 *   node tools/label-print/dist/index.js seal  --package <id> --photo <file> [--person <id>]
 *
 * `print` generates the seam secret, splits it across the two QR codes, and
 * writes the label at print size, as an SVG and as a PDF. The secret is in
 * those two drawings and nowhere else: what is kept beside it is the commitment, which opens nothing.
 *
 * `seal` is run once the label is on the closed packet and has been
 * photographed. It signs a SEAL_APPLIED event with this device's key, holding
 * the commitment and the hash of the photograph, and sends it to the ledger,
 * which records the event and registers the commitment for every later scan.
 *
 * The device key is read from --device-key (default secrets/press-device.json,
 * a git-ignored path). If the file is not there, a new device is enrolled with
 * the ledger and its key written to it.
 *
 * Options:
 *   --ledger <url>        default $LEDGER_URL or http://localhost:8081
 *   --out <dir>           where labels are written, default ./labels
 *   --verify-host <url>   what the QR codes point at, default $VERIFY_HOST or
 *                         https://mohar.example (a reserved name: there is no
 *                         public check page yet, so an ordinary scan lands nowhere)
 *   --papers <n>          papers counted into the packet, default the planned copies
 *   --lat --lon --accuracy   where the sealing happened
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildSealEvent,
  enrolDevice,
  httpApi,
  loadPacket,
  makeLabel,
  submitSeal,
  type Device,
  type PendingLabel,
} from "./seal.js";

const [command, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i];
  const v = rest[i + 1];
  if (k?.startsWith("--") && v !== undefined) args.set(k.slice(2), v);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const packageId = args.get("package");
if ((command !== "print" && command !== "seal") || !packageId) {
  fail(
    "usage:\n" +
      "  label-print print --package <id> [--labels 1|2] [--serial <serial>] [--out <dir>]\n" +
      "  label-print seal  --package <id> --photo <file> [--person <id>] [--papers <n>]",
  );
}

const api = httpApi(args.get("ledger") ?? process.env["LEDGER_URL"] ?? "http://localhost:8081");
const outDir = resolve(args.get("out") ?? "labels");
const pendingPath = join(outDir, `${packageId}.pending.json`);

async function loadDevice(path: string): Promise<Device> {
  if (existsSync(path)) {
    const d = JSON.parse(await readFile(path, "utf8")) as Partial<Device>;
    if (!d.deviceId || !d.privateKeyHex) fail(`${path} is not a device key file`);
    return { deviceId: d.deviceId, privateKeyHex: d.privateKeyHex };
  }
  const device = await enrolDevice(api);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(device, null, 2) + "\n", { mode: 0o600 });
  console.log(`Enrolled a new press device ${device.deviceId}; its key is in ${path}`);
  return device;
}

try {
  const packet = await loadPacket(api, packageId);

  if (command === "print") {
    if (existsSync(pendingPath)) {
      fail(
        `A label for this package was already printed (${pendingPath}).\n` +
          "A second label would carry a different secret. If the first was destroyed before it\n" +
          "was applied, delete that file and print again.",
      );
    }
    const labels = args.get("labels") ?? "1";
    if (labels !== "1" && labels !== "2") fail("--labels must be 1 or 2");
    const serial = args.get("serial");
    const { art, pdf, pending } = makeLabel(packet, {
      verifyHost: args.get("verify-host") ?? process.env["VERIFY_HOST"] ?? "https://mohar.example",
      labelsPerPacket: labels === "2" ? 2 : 1,
      ...(serial ? { packetSerial: serial } : {}),
    });
    await mkdir(outDir, { recursive: true });
    const svgPath = join(outDir, `${pending.packetSerial}.svg`);
    const pdfPath = join(outDir, `${pending.packetSerial}.pdf`);
    await writeFile(svgPath, art.svg);
    await writeFile(pdfPath, pdf);
    await writeFile(pendingPath, JSON.stringify(pending, null, 2) + "\n");
    console.log(`Label       ${svgPath}`);
    console.log(`            ${pdfPath}`);
    console.log(`Size        ${art.widthMm} x ${art.heightMm} mm, QR version ${art.qrVersion}, level L, 0.5 mm modules`);
    console.log(`Seam id     ${pending.seamId}`);
    console.log(`Commitment  ${pending.labelCommitment}`);
    console.log(
      "\nThese two files are the only copies of the seam secret. Print one, apply the label\n" +
        "across the flap, photograph it, then delete both and run `seal` with the photograph.",
    );
  } else {
    if (!existsSync(pendingPath)) fail(`No printed label on record for this package; run \`print\` first.`);
    const photo = args.get("photo");
    if (!photo) fail("--photo <file> is required: the photograph of the label on the closed packet");
    const pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingLabel;
    const photoSha256 = createHash("sha256").update(await readFile(photo)).digest("hex");

    const lat = args.get("lat");
    const lon = args.get("lon");
    const person = args.get("person");
    const papers = args.get("papers");
    const device = await loadDevice(resolve(args.get("device-key") ?? "secrets/press-device.json"));
    const signed = buildSealEvent(packet, pending, device, {
      photoSha256,
      ...(person ? { personId: person } : {}),
      ...(papers ? { paperCount: Number(papers) } : {}),
      ...(lat && lon
        ? { geo: { lat: Number(lat), lon: Number(lon), accuracyM: Number(args.get("accuracy") ?? 25) } }
        : {}),
    });
    const result = await submitSeal(api, signed);
    if (!result.sealed) {
      fail(`The ledger did not register this sealing (${result.status}):\n${JSON.stringify(result.body, null, 2)}`);
    }
    const event = (result.body as { event?: { seq?: string; hash?: string } }).event;
    console.log(`Sealed      ${pending.packetSerial}`);
    console.log(`Seam id     ${pending.seamId}`);
    console.log(`Photograph  sha256 ${photoSha256}`);
    console.log(`Chain       seq ${event?.seq ?? "?"}, hash ${event?.hash ?? "?"}`);
  }
} catch (err) {
  fail((err as Error).message);
}
