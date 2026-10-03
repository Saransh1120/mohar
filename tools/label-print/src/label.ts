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

/** The seam id in groups of four, the way it is read aloud. */
export function groupSeamId(seamId: string): string {
  return seamId.replace(/(.{4})(?=.)/g, "$1 ");
}

export interface LabelText {
  /** Centre of the line, and its baseline, in millimetres. */
  x: number;
  y: number;
  sizeMm: number;
  text: string;
  bold: boolean;
}

/** One label as shapes, in millimetres from the sheet's top-left corner. */
export interface LabelShapes {
  /** The cut line: the label's own outline. */
  outline: { x: number; y: number; width: number; height: number };
  /** Top-left corner of every dark module, QR 1 then QR 2. */
  modules: { a: [number, number][]; b: [number, number][] };
  /** The three marks the flap edge is aligned to: [x1, x2, y]. */
  ticks: [number, number, number][];
  texts: LabelText[];
}

export interface LabelLayout {
  widthMm: number;
  /** One label, without the gap between copies. */
  heightMm: number;
  sheetHeightMm: number;
  qrVersion: number;
  labels: LabelShapes[];
}

/**
 * Where everything on the label goes.
 *
 * The SVG and the PDF are both drawn from this, so the two cannot disagree
 * about a module's position: a label that scans from one file and not from the
 * other would be found on a press floor, not here.
 */
export function layoutLabel(input: LabelInput): LabelLayout {
  const a = qrMatrix(input.urlA);
  const b = qrMatrix(input.urlB);
  // The two halves are the same length, so the same version; if they ever were
  // not, the larger one decides the size and the smaller is centred in its box.
  const size = Math.max(a.size, b.size);
  const box = (size + 2 * QUIET_MODULES) * MODULE_MM;
  const width = 2 * MARGIN_MM + 2 * box + GAP_MM;
  const height = 2 * MARGIN_MM + box + TEXT_BAND_MM;

  const dark = (m: QrMatrix, originX: number, originY: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let y = 0; y < m.size; y += 1) {
      for (let x = 0; x < m.size; x += 1) {
        if (m.dark(x, y)) out.push([mm(originX + x * MODULE_MM), mm(originY + y * MODULE_MM)]);
      }
    }
    return out;
  };

  const one = (offsetY: number): LabelShapes => {
    const top = offsetY + MARGIN_MM;
    const leftA = MARGIN_MM;
    const leftB = MARGIN_MM + box + GAP_MM;
    const inset = (m: QrMatrix) => (QUIET_MODULES + (size - m.size) / 2) * MODULE_MM;
    // The flap edge belongs across the middle of the top finder patterns,
    // which are seven modules tall.
    const flapY = mm(top + (QUIET_MODULES + 3.5) * MODULE_MM);
    const textTop = top + box;
    const line = (x: number, dy: number, sizeMm: number, text: string, bold = false): LabelText => ({
      x: mm(x),
      y: mm(textTop + dy),
      sizeMm,
      text,
      bold,
    });
    return {
      outline: { x: 0.1, y: mm(offsetY + 0.1), width: mm(width - 0.2), height: mm(height - 0.2) },
      modules: {
        a: dark(a, leftA + inset(a), top + inset(a)),
        b: dark(b, leftB + inset(b), top + inset(b)),
      },
      ticks: [
        [0.3, mm(MARGIN_MM - 0.3), flapY],
        [mm(leftA + box + 0.3), mm(leftB - 0.3), flapY],
        [mm(width - MARGIN_MM + 0.3), mm(width - 0.3), flapY],
      ],
      texts: [
        line(leftA + box / 2, 1.6, 1.5, "QR 1"),
        line(leftB + box / 2, 1.6, 1.5, "QR 2"),
        line(width / 2, 4.4, 2, groupSeamId(input.seamId), true),
        line(width / 2, 6.8, 1.7, `SERIAL ${input.packetSerial}`),
        line(width / 2, 8.8, 1.2, "Apply across the flap, flap edge on the three side marks"),
      ],
    };
  };

  const sheetGap = 4;
  return {
    widthMm: mm(width),
    heightMm: mm(height),
    sheetHeightMm: mm(input.copies === 2 ? 2 * height + sheetGap : height),
    qrVersion: Math.max(a.version, b.version),
    labels: input.copies === 2 ? [one(0), one(height + sheetGap)] : [one(0)],
  };
}

export function renderLabelSvg(input: LabelInput): LabelArt {
  const layout = layoutLabel(input);
  const path = (modules: [number, number][]) =>
    modules.map(([x, y]) => `M${x} ${y}h${MODULE_MM}v${MODULE_MM}h-${MODULE_MM}z`).join("");

  const bodies = layout.labels.map((l) =>
    [
      `<rect x="${l.outline.x}" y="${l.outline.y}" width="${l.outline.width}" height="${l.outline.height}" rx="1" fill="#fff" stroke="#000" stroke-width="0.15"/>`,
      `<path d="${path(l.modules.a)}" fill="#000" shape-rendering="crispEdges"/>`,
      `<path d="${path(l.modules.b)}" fill="#000" shape-rendering="crispEdges"/>`,
      ...l.ticks.map(
        ([x1, x2, y]) =>
          `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#000" stroke-width="0.2"/>`,
      ),
      ...l.texts.map(
        (t) =>
          `<text x="${t.x}" y="${t.y}" font-size="${t.sizeMm}"${t.bold ? ' font-weight="bold"' : ""} text-anchor="middle">${esc(t.text)}</text>`,
      ),
    ].join("\n  "),
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.widthMm}mm" height="${layout.sheetHeightMm}mm" ` +
    `viewBox="0 0 ${layout.widthMm} ${layout.sheetHeightMm}" font-family="DejaVu Sans Mono, Consolas, monospace">\n  ` +
    bodies.join("\n  ") +
    "\n</svg>\n";

  return { svg, widthMm: layout.widthMm, heightMm: layout.heightMm, qrVersion: layout.qrVersion };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/** Points per millimetre. A PDF page is measured in points, 72 to the inch. */
const PT = 72 / 25.4;

/** Courier is fixed-pitch: every glyph is 0.6 of the font size wide. */
const COURIER_ADVANCE = 0.6;

const pt = (n: number) => Number((n * PT).toFixed(3));

/** A PDF literal string. Anything outside printable ASCII is dropped, not guessed at. */
function pdfString(text: string): string {
  return `(${text.replace(/[^\x20-\x7e]/g, "").replace(/([\\()])/g, "\\$1")})`;
}

/**
 * The same label as a one-page PDF, at print size.
 *
 * Written out directly rather than through a PDF library: the page is a few
 * hundred filled squares, three lines and five lines of text in a font every
 * PDF reader already has, and a dependency would be larger than the file it
 * writes. The page is exactly the size of the label sheet, so a thermal
 * printer driver set to "actual size" prints it at scale.
 *
 * PDF measures up from the bottom-left corner, the layout measures down from
 * the top-left, so every y is flipped here and nowhere else.
 */
export function renderLabelPdf(input: LabelInput): Uint8Array {
  const layout = layoutLabel(input);
  const W = pt(layout.widthMm);
  const H = pt(layout.sheetHeightMm);
  const flip = (yMm: number) => Number((H - yMm * PT).toFixed(3));
  const m = pt(MODULE_MM);

  const ops: string[] = [];
  for (const l of layout.labels) {
    // The outline, as the line to cut along.
    ops.push(
      `${pt(0.15)} w 0 G`,
      `${pt(l.outline.x)} ${flip(l.outline.y + l.outline.height)} ${pt(l.outline.width)} ${pt(l.outline.height)} re S`,
    );
    // Every dark module is one filled square, all painted in one fill.
    ops.push("0 g");
    for (const [x, y] of [...l.modules.a, ...l.modules.b]) {
      ops.push(`${pt(x)} ${flip(y + MODULE_MM)} ${m} ${m} re`);
    }
    ops.push("f");
    ops.push(`${pt(0.2)} w`);
    for (const [x1, x2, y] of l.ticks) ops.push(`${pt(x1)} ${flip(y)} m ${pt(x2)} ${flip(y)} l S`);
    for (const t of l.texts) {
      const size = pt(t.sizeMm);
      const clean = t.text.replace(/[^\x20-\x7e]/g, "");
      const left = Number((pt(t.x) - (clean.length * COURIER_ADVANCE * size) / 2).toFixed(3));
      ops.push(`BT /${t.bold ? "F2" : "F1"} ${size} Tf ${left} ${flip(t.y)} Td ${pdfString(clean)} Tj ET`);
    }
  }
  const content = ops.join("\n") + "\n";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, "latin1");
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(body, "latin1"));
}
