import { useSyncExternalStore } from "react";

/**
 * ── The station over a USB cable ─────────────────────────────────────────────
 *
 * The same witness station, reached through the browser's Web Serial API
 * instead of the exam-hall Wi-Fi. Plug the ESP32 into this laptop, press
 * Connect over USB, pick the port, and the station is live — no SSID, no
 * hotspot subnet, no station IP, no ledger IP to keep in step.
 *
 * Two jobs happen on the one cable:
 *
 *  1. Commands. Status, enrol, cancel and delete travel as "@<id> <command>"
 *     lines and come back as "@R <id> {json}" or "@E <id> {json}", so
 *     `station.ts` can offer the exact same calls it makes over HTTP.
 *
 *  2. Records. The station prints each signed record as "@EVT <n> <json>";
 *     this module posts it to the ledger unchanged and answers "@ack <n>" or
 *     "@retry <n>". The station only drops a record from its queue on an ack.
 *
 * This page is a courier, not a signer. Every record is signed on the ESP32
 * with the key in its flash and verified by the ledger exactly as a Wi-Fi post
 * would be; altering one in transit would fail the signature. Nothing here
 * holds a device key.
 */

export const USB_BASE = "usb://station";

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface SerialLike {
  requestPort(options?: { filters?: unknown[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

const serial = (): SerialLike | undefined =>
  (navigator as unknown as { serial?: SerialLike }).serial;

/** Web Serial exists in desktop Chrome and Edge only. */
export const usbSupported = (): boolean => !!serial();

// ── observable state ────────────────────────────────────────────────────────

export interface UsbState {
  connected: boolean;
  deviceId: string | null;
  /** Set when the station stopped at boot and said why (e.g. no DS3231). */
  halted: string | null;
  relayed: number;
  rejected: number;
  lastError: string | null;
}

let state: UsbState = {
  connected: false,
  deviceId: null,
  halted: null,
  relayed: 0,
  rejected: 0,
  lastError: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<UsbState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useUsbStation(): UsbState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => state,
  );
}

export const usbState = (): UsbState => state;

// ── the port ────────────────────────────────────────────────────────────────

let port: SerialPortLike | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let helloTimer: number | null = null;
let nextId = 1;
const waiting = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
>();
const enc = new TextEncoder();

async function send(line: string): Promise<void> {
  if (!writer) throw new Error("the station is not connected over USB");
  await writer.write(enc.encode(line + "\n"));
}

function teardown(reason: string | null): void {
  if (helloTimer !== null) window.clearInterval(helloTimer);
  helloTimer = null;
  try {
    writer?.releaseLock();
  } catch {
    /* already released */
  }
  writer = null;
  const p = port;
  port = null;
  void p?.close().catch(() => undefined);
  for (const [, w] of waiting) {
    window.clearTimeout(w.timer);
    w.reject(new Error("the USB connection to the station closed"));
  }
  waiting.clear();
  set({ connected: false, ...(reason ? { lastError: reason } : {}) });
}

async function openPort(p: SerialPortLike): Promise<void> {
  await p.open({ baudRate: 115200 });
  // Opening the port pulses DTR and RTS, which on a DevKit resets the board
  // through its auto-reset circuit. Releasing both lets it boot normally
  // rather than sit in the bootloader.
  await p.setSignals?.({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
  if (!p.writable || !p.readable) throw new Error("the port opened without a data stream");

  port = p;
  writer = p.writable.getWriter();
  set({ connected: true, halted: null, lastError: null });
  void readLoop(p);

  // The station treats silence for 15 s as the host having gone, and falls
  // back to Wi-Fi. A hello every few seconds keeps it on the cable.
  helloTimer = window.setInterval(() => void send("@hello").catch(() => undefined), 4000);
  await new Promise((r) => setTimeout(r, 1500)); // a reset board needs a moment to boot
  await send("@hello");
}

/** Ask the browser for the port. Must be called from a click. */
export async function connectUsb(): Promise<void> {
  const s = serial();
  if (!s) {
    throw new Error("This browser cannot open USB serial ports — use Chrome or Edge on a desktop.");
  }
  if (state.connected) return;
  const p = await s.requestPort({});
  await openPort(p);
}

/** Reopen a port this browser was already given, without asking again. */
export async function resumeUsb(): Promise<boolean> {
  const s = serial();
  if (!s) return false;
  if (state.connected) return true;
  const [p] = await s.getPorts();
  if (!p) return false;
  try {
    await openPort(p);
    return true;
  } catch {
    return false;
  }
}

export function disconnectUsb(): void {
  teardown(null);
}

async function readLoop(p: SerialPortLike): Promise<void> {
  if (!p.readable) return;
  const reader = p.readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("@")) void handleLine(line);
      }
      if (buf.length > 64_000) buf = ""; // a runaway line is noise, not a record
    }
    teardown(null);
  } catch (err) {
    teardown(`the USB link dropped: ${(err as Error).message}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function handleLine(line: string): Promise<void> {
  if (line.startsWith("@HELLO ")) {
    try {
      const b = JSON.parse(line.slice(7)) as { deviceId?: string };
      set({ deviceId: b.deviceId ?? null, halted: null });
    } catch {
      /* a malformed hello changes nothing */
    }
    return;
  }

  if (line.startsWith("@HALT ")) {
    let reason = "the station stopped at boot";
    try {
      reason = (JSON.parse(line.slice(6)) as { reason?: string }).reason ?? reason;
    } catch {
      /* keep the generic reason */
    }
    set({ halted: reason });
    return;
  }

  if (line.startsWith("@EVT ")) {
    const sp = line.indexOf(" ", 5);
    if (sp < 0) return;
    const n = line.slice(5, sp);
    const record = line.slice(sp + 1);
    let res: Response;
    try {
      res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: record,
      });
    } catch {
      await send(`@retry ${n}`).catch(() => undefined);
      return;
    }
    // Same meaning the station's own Wi-Fi client gives these codes:
    // 201 appended and 200 duplicate are delivered; 422 is dropped and counted
    // rather than retried forever; anything else is tried again.
    if (res.status === 201 || res.status === 200) {
      set({ relayed: state.relayed + 1 });
      await send(`@ack ${n}`).catch(() => undefined);
    } else if (res.status === 422) {
      set({ rejected: state.rejected + 1 });
      await send(`@ack ${n}`).catch(() => undefined);
    } else {
      await send(`@retry ${n}`).catch(() => undefined);
    }
    return;
  }

  if (line.startsWith("@R ") || line.startsWith("@E ")) {
    const ok = line[1] === "R";
    const rest = line.slice(3);
    const sp = rest.indexOf(" ");
    if (sp < 0) return;
    const id = rest.slice(0, sp);
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    window.clearTimeout(w.timer);
    let body: unknown = {};
    try {
      body = JSON.parse(rest.slice(sp + 1));
    } catch {
      /* an unparseable body still answers the request */
    }
    if (ok) w.resolve(body);
    else w.reject(new Error((body as { error?: string }).error ?? "the station refused"));
  }
}

/** Send one command and wait for its answer. */
export async function usbRequest<T>(command: string, timeoutMs = 8000): Promise<T> {
  if (!state.connected && !(await resumeUsb())) {
    throw new Error("The station is not connected over USB. Plug it in and press Connect over USB.");
  }
  if (state.halted) {
    throw new Error(`The station stopped at boot: ${state.halted}. Fix that, then press the board's reset button.`);
  }
  const id = String(nextId++);
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      reject(
        new Error(
          "The station did not answer over USB within 8 seconds. It may still be booting — or the board " +
            "is running a different sketch. WitnessNode is the one that speaks USB.",
        ),
      );
    }, timeoutMs);
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    send(`@${id} ${command}`).catch((e: Error) => {
      window.clearTimeout(timer);
      waiting.delete(id);
      reject(e);
    });
  });
}
