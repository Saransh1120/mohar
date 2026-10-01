import QRCode from "qrcode";

/**
 * ── The label as a drawing ───────────────────────────────────────────────────
 *
 * One label carries two QR codes side by side, the seam id in print beneath
 * them, and the packet serial. It is applied across the closure flap so the
 * flap edge runs through the top of both codes: opening the packet tears each
 * code through a finder pattern, and neither reads afterwards.
 *
 * Error correction is level L, the lowest. On most labels that would be the
 * wrong choice; here it is the point. A code that survives damage is a code
 * that survives being torn, and this one is meant not to.
 *
 * Everything is in millimetres, so the SVG prints at size on a thermal-transfer
 * printer without scaling.
 */

/** Module size. 0.5 mm is the smallest a phone camera reads reliably off vinyl. */
export const MODULE_MM = 0.5;
/** The blank border a QR code needs around it, in modules. */
const QUIET_MODULES = 4;
const MARGIN_MM = 2;
const GAP_MM = 3;
const TEXT_BAND_MM = 9.5;

export interface QrMatrix {
  /** Modules per side. */
  size: number;
  version: number;
  dark(x: number, y: number): boolean;
}

/** The module grid for one code, at error correction level L. */
export function qrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  const { size, data } = qr.modules;
  return {
    size,
    version: qr.version,
    dark: (x, y) => data[y * size + x] === 1,
  };
}

export interface LabelInput {
  seamId: string;
  /** What QR 1 and QR 2 encode. */
  urlA: string;
  urlB: string;
  packetSerial: string;
  /** 1, or 2 for a second identical label on the opposite flap. */
  copies: 1 | 2;
}

export interface LabelArt {
  svg: string;
  /** One label, without the gap between copies. */
  widthMm: number;
  heightMm: number;
  qrVersion: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mm = (n: number) => Number(n.toFixed(3));

function qrPath(m: QrMatrix, originX: number, originY: number): string {
  let d = "";
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (!m.dark(x, y)) continue;
      d += `M${mm(originX + x * MODULE_MM)} ${mm(originY + y * MODULE_MM)}h${MODULE_MM}v${MODULE_MM}h-${MODULE_MM}z`;
    }
  }
  return d;
}

/** The seam id in groups of four, the way it is read aloud. */
export function groupSeamId(seamId: string): string {
  return seamId.replace(/(.{4})(?=.)/g, "$1 ");
}

export function renderLabelSvg(input: LabelInput): LabelArt {
  const a = qrMatrix(input.urlA);
  const b = qrMatrix(input.urlB);
  // The two halves are the same length, so the same version; if they ever were
  // not, the larger one decides the size and the smaller is centred in its box.
  const size = Math.max(a.size, b.size);
  const box = (size + 2 * QUIET_MODULES) * MODULE_MM;
  const width = 2 * MARGIN_MM + 2 * box + GAP_MM;
  const height = 2 * MARGIN_MM + box + TEXT_BAND_MM;

  const one = (offsetY: number): string => {
    const top = offsetY + MARGIN_MM;
    const leftA = MARGIN_MM;
    const leftB = MARGIN_MM + box + GAP_MM;
    const inset = (m: QrMatrix) => (QUIET_MODULES + (size - m.size) / 2) * MODULE_MM;
    // The flap edge belongs across the middle of the top finder patterns,
    // which are seven modules tall.
    const flapY = top + (QUIET_MODULES + 3.5) * MODULE_MM;
    const tick = (x1: number, x2: number) =>
      `<line x1="${mm(x1)}" y1="${mm(flapY)}" x2="${mm(x2)}" y2="${mm(flapY)}" stroke="#000" stroke-width="0.2"/>`;
    const textTop = top + box;
    return [
      `<rect x="0.1" y="${mm(offsetY + 0.1)}" width="${mm(width - 0.2)}" height="${mm(height - 0.2)}" rx="1" fill="#fff" stroke="#000" stroke-width="0.15"/>`,
      `<path d="${qrPath(a, leftA + inset(a), top + inset(a))}" fill="#000" shape-rendering="crispEdges"/>`,
      `<path d="${qrPath(b, leftB + inset(b), top + inset(b))}" fill="#000" shape-rendering="crispEdges"/>`,
      tick(0.3, MARGIN_MM - 0.3),
      tick(leftA + box + 0.3, leftB - 0.3),
      tick(width - MARGIN_MM + 0.3, width - 0.3),
      `<text x="${mm(leftA + box / 2)}" y="${mm(textTop + 1.6)}" font-size="1.5" text-anchor="middle">QR 1</text>`,
      `<text x="${mm(leftB + box / 2)}" y="${mm(textTop + 1.6)}" font-size="1.5" text-anchor="middle">QR 2</text>`,
      `<text x="${mm(width / 2)}" y="${mm(textTop + 4.4)}" font-size="2" font-weight="bold" text-anchor="middle">${esc(groupSeamId(input.seamId))}</text>`,
      `<text x="${mm(width / 2)}" y="${mm(textTop + 6.8)}" font-size="1.7" text-anchor="middle">SERIAL ${esc(input.packetSerial)}</text>`,
      `<text x="${mm(width / 2)}" y="${mm(textTop + 8.8)}" font-size="1.2" text-anchor="middle">Apply across the flap, flap edge on the three side marks</text>`,
    ].join("\n  ");
  };

  const sheetGap = 4;
  const sheetHeight = input.copies === 2 ? 2 * height + sheetGap : height;
  const bodies = input.copies === 2 ? [one(0), one(height + sheetGap)] : [one(0)];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(width)}mm" height="${mm(sheetHeight)}mm" ` +
    `viewBox="0 0 ${mm(width)} ${mm(sheetHeight)}" font-family="DejaVu Sans Mono, Consolas, monospace">\n  ` +
    bodies.join("\n  ") +
    "\n</svg>\n";

  return { svg, widthMm: mm(width), heightMm: mm(height), qrVersion: Math.max(a.version, b.version) };
}
