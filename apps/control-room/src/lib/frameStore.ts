/**
 * ── Where the photographs actually live ──────────────────────────────────────
 *
 * The chain holds a SHA-256 and nothing else. That was a deliberate choice and
 * it does not change here: an image in an append-only ledger is an image that
 * can never be deleted, and a system that photographs people should not also be
 * the system that can never forget them.
 *
 * But a commitment with nothing to check it against proves only that *some*
 * bytes existed. Until now the JPEG lived in React state and was gone at the
 * next refresh, which meant every hash in the chain was unverifiable within
 * minutes of being written. This module gives the bytes somewhere to sit.
 *
 * What that buys, precisely: a frame stored here can be re-hashed and compared
 * to the digest the ledger accepted at capture time. If they match, this is the
 * photograph that was committed — not a similar one, not a later one.
 *
 * What it does not buy, and must not be claimed:
 *
 *   • IndexedDB is per-browser-profile. Clear site data, use another machine,
 *     open a private window, and the images are gone. The commitments survive;
 *     the ability to check them does not.
 *   • Nothing here is tamper-evident on its own. Anyone with access to this
 *     profile can delete a frame. They cannot substitute one — a replacement
 *     would fail the re-hash — but absence is not proof of innocence, and a
 *     missing frame must read as "cannot be checked", never as "fine".
 *   • The store is not encrypted. It is a folder of faces on somebody's laptop.
 *     Retention is the operator's problem and `clearFrames` exists for it.
 */

const DB_NAME = "mohar.frames";
const DB_VERSION = 1;
const STORE = "frames";

/** Which path took the photograph. The two mean very different things. */
export type FrameKind = "assertion" | "refusal";

export interface StoredFrame {
  /** The `WITNESS_FRAME` / `ACCESS_FRAME` event id — the commitment itself. */
  id: string;
  kind: FrameKind;
  /** The assertion or decision this frame was bound to when committed. */
  boundEventId: string;
  sessionId: string | null;
  packageId: string | null;
  /** The digest the ledger accepted. Re-hashing the blob must reproduce this. */
  sha256: string;
  /** Ledger sequence of the commitment, so a frame can be found in the chain. */
  seq: string;
  capturedAt: string;
  width: number;
  height: number;
  bytes: number;
  blob: Blob;
  /** For a refusal: what the engine objected to. Empty on the ceremony path. */
  reasons: string[];
}

/**
 * IndexedDB is not guaranteed to exist.
 *
 * Private windows, hardened profiles and enterprise policy all take it away,
 * and in some of those the failure is a throw on first access rather than a
 * missing global. Every entry point below resolves to a harmless value instead
 * of rejecting, because a page that cannot store photographs must still be able
 * to take and commit them — the ledger half is the half that matters.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("capturedAt", "capturedAt");
          store.createIndex("boundEventId", "boundEventId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // A second tab holding an older version open blocks the upgrade forever.
      // Better to run without a store than to hang the witness page.
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Wrap one request. Rejects only on a real IndexedDB error, never on absence. */
function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Store one frame.
 *
 * Called only after the ledger has accepted the commitment. Storing first would
 * leave images on disk for frames the chain never recorded, which is the one
 * combination with no honest reading — a photograph of somebody that no event
 * accounts for.
 */
export async function putFrame(frame: StoredFrame): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await wrap(tx(db, "readwrite").put(frame));
  } catch {
    // A full disk or a quota refusal loses the image, not the commitment.
    // Silence is right here: the caller has already succeeded at the part that
    // is evidence, and an error banner would suggest otherwise.
  }
}

/** Every stored frame, newest first. */
export async function allFrames(): Promise<StoredFrame[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const rows = await wrap(tx(db, "readonly").getAll() as IDBRequest<StoredFrame[]>);
    return rows.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  } catch {
    return [];
  }
}

export async function deleteFrame(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await wrap(tx(db, "readwrite").delete(id));
  } catch {
    /* nothing useful to tell the operator */
  }
}

export async function clearFrames(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await wrap(tx(db, "readwrite").clear());
  } catch {
    /* nothing useful to tell the operator */
  }
}

/** Is there a store at all? The page says so rather than pretending. */
export async function storeAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

export const sha256OfBlob = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export type VerifyResult =
  | { status: "match"; sha256: string }
  | { status: "mismatch"; expected: string; actual: string }
  | { status: "error"; detail: string };

/**
 * Re-hash the stored bytes and compare them to the committed digest.
 *
 * This is the whole point of keeping the file, so it is done for real: the
 * blob is read back out of IndexedDB and put through the same SHA-256 the
 * capture path used. A mismatch is not a display bug — it means the image on
 * this machine is not the image the chain attested to, and the frame should be
 * treated as having no evidential value at all.
 */
export async function verifyFrame(frame: StoredFrame): Promise<VerifyResult> {
  try {
    const actual = await sha256OfBlob(frame.blob);
    return actual === frame.sha256
      ? { status: "match", sha256: actual }
      : { status: "mismatch", expected: frame.sha256, actual };
  } catch (err) {
    return { status: "error", detail: (err as Error).message };
  }
}

/** A filename that says what the file is without needing the page open. */
export function frameFileName(frame: StoredFrame): string {
  const stamp = frame.capturedAt.replace(/[:.]/g, "-");
  return `mohar-${frame.kind}-${stamp}-${frame.sha256.slice(0, 12)}.jpg`;
}
