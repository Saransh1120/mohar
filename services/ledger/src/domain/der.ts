/**
 * A reader for DER, enough of it to walk an X.509 certificate to one extension
 * and take that extension apart.
 *
 * node:crypto verifies signatures and reads the standard fields of a
 * certificate, but it does not hand back the bytes of an extension it does not
 * know, and the Android key description is one of those. This reads tags,
 * lengths and values; it does not interpret anything.
 *
 * Every malformed input throws DerError. Callers catch it and report the
 * attestation as unreadable; nothing here returns a partial answer.
 */

export class DerError extends Error {}

export interface Tlv {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  tag: number;
  value: Uint8Array;
  /** Header and value together, as they appeared. */
  raw: Uint8Array;
}

export function readTlv(buf: Uint8Array, offset = 0): { tlv: Tlv; next: number } {
  let i = offset;
  const first = buf[i++];
  if (first === undefined) throw new DerError("ran out of bytes reading a tag");
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    // High tag number: base 128, most significant group first.
    tag = 0;
    for (let groups = 0; ; groups += 1) {
      const b = buf[i++];
      if (b === undefined) throw new DerError("ran out of bytes reading a long tag");
      if (groups >= 4) throw new DerError("tag number is too large");
      tag = (tag << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }

  const lenByte = buf[i++];
  if (lenByte === undefined) throw new DerError("ran out of bytes reading a length");
  let length = lenByte;
  if (lenByte & 0x80) {
    const n = lenByte & 0x7f;
    if (n === 0) throw new DerError("indefinite length is not DER");
    if (n > 4) throw new DerError("length is too large");
    length = 0;
    for (let k = 0; k < n; k += 1) {
      const b = buf[i++];
      if (b === undefined) throw new DerError("ran out of bytes reading a long length");
      length = length * 256 + b;
    }
  }
  const end = i + length;
  if (end > buf.length) throw new DerError("a value runs past the end of the data");
  return {
    tlv: { cls, constructed, tag, value: buf.subarray(i, end), raw: buf.subarray(offset, end) },
    next: end,
  };
}

/** Every element directly inside a constructed value. */
export function children(tlv: Tlv): Tlv[] {
  if (!tlv.constructed) throw new DerError("expected a constructed value");
  return sequenceOf(tlv.value);
}

/** Every element in a run of bytes, one after another, with nothing left over. */
export function sequenceOf(buf: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  let i = 0;
  while (i < buf.length) {
    const { tlv, next } = readTlv(buf, i);
    out.push(tlv);
    i = next;
  }
  return out;
}

export const TAG = { BOOLEAN: 1, INTEGER: 2, OCTET_STRING: 4, OID: 6, ENUMERATED: 10, SEQUENCE: 16 } as const;

function expectUniversal(tlv: Tlv | undefined, tag: number, what: string): Tlv {
  if (!tlv || tlv.cls !== 0 || tlv.tag !== tag) throw new DerError(`expected ${what}`);
  return tlv;
}

/** INTEGER or ENUMERATED as a number. Refuses anything that would not fit. */
export function smallInt(tlv: Tlv | undefined, what: string): number {
  if (!tlv || tlv.cls !== 0 || (tlv.tag !== TAG.INTEGER && tlv.tag !== TAG.ENUMERATED)) {
    throw new DerError(`expected ${what} to be an integer`);
  }
  if (tlv.value.length === 0 || tlv.value.length > 6) throw new DerError(`${what} is out of range`);
  let n = 0;
  for (const b of tlv.value) n = n * 256 + b;
  if ((tlv.value[0]! & 0x80) !== 0) throw new DerError(`${what} is negative`);
  return n;
}

export function octets(tlv: Tlv | undefined, what: string): Uint8Array {
  return expectUniversal(tlv, TAG.OCTET_STRING, `${what} to be an octet string`).value;
}

export function bool(tlv: Tlv | undefined, what: string): boolean {
  const v = expectUniversal(tlv, TAG.BOOLEAN, `${what} to be a boolean`).value;
  if (v.length !== 1) throw new DerError(`${what} is not a one-byte boolean`);
  return v[0] !== 0;
}

export function sequence(tlv: Tlv | undefined, what: string): Tlv[] {
  return children(expectUniversal(tlv, TAG.SEQUENCE, `${what} to be a sequence`));
}

/** Dotted form of an OBJECT IDENTIFIER. */
export function oid(tlv: Tlv | undefined): string {
  const v = expectUniversal(tlv, TAG.OID, "an object identifier").value;
  if (v.length === 0) throw new DerError("empty object identifier");
  const parts: number[] = [Math.floor(v[0]! / 40), v[0]! % 40];
  let n = 0;
  for (const b of v.subarray(1)) {
    n = n * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

/**
 * The value of one extension of an X.509 certificate, by OID, or null when the
 * certificate does not carry it.
 *
 *   Certificate  ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate ::= SEQUENCE { ..., extensions [3] EXPLICIT SEQUENCE OF Extension }
 *   Extension    ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
 */
export function certificateExtension(certDer: Uint8Array, extensionOid: string): Uint8Array | null {
  const cert = sequence(readTlv(certDer).tlv, "the certificate");
  const tbs = sequence(cert[0], "the certificate body");
  const wrapper = tbs.find((t) => t.cls === 2 && t.tag === 3 && t.constructed);
  if (!wrapper) return null;
  for (const ext of sequence(children(wrapper)[0], "the extension list")) {
    const fields = children(ext);
    if (oid(fields[0]) === extensionOid) {
      return octets(fields[fields.length - 1], "the extension value");
    }
  }
  return null;
}

/** Split concatenated DER certificates into one buffer each. */
export function splitDer(buf: Uint8Array): Uint8Array[] {
  return sequenceOf(buf).map((t) => t.raw);
}
