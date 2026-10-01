import { canonicalBytes, requestSigningBytes, REQUEST_SIGNATURE_HEADERS } from "@mohar/crypto-core";
import jsQR from "jsqr";
import "./style.css";

interface Identity { deviceId: string; examId: string; centreId: string; personId: string; }
interface Queued { id: string; signed: { body: Record<string, unknown>; deviceSig: string }; error?: string; }
const DB = "mohar-field-v1";
const operatorHeaders = () => {
  try {
    const token = localStorage.getItem("mohar.session");
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("settings");
      db.createObjectStore("queue", { keyPath: "id" });
      db.createObjectStore("photos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transact<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    let result: T;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(tx.error ?? req.error); };
    tx.onerror = () => { db.close(); reject(tx.error ?? req.error); };
  });
}
const get = <T>(store: string, key: IDBValidKey) => transact<T | undefined>(store, "readonly", (s) => s.get(key));
const put = (store: string, value: unknown, key?: IDBValidKey) => transact(store, "readwrite", (s) => key === undefined ? s.put(value) : s.put(value, key));
const remove = (store: string, key: IDBValidKey) => transact(store, "readwrite", (s) => s.delete(key));
const all = <T>(store: string) => transact<T[]>(store, "readonly", (s) => s.getAll());
const hex = (b: ArrayBufferLike) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join("");
const validId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `<header><strong>Mohar Field</strong><span id="online"></span></header><section><h1>Courier scan</h1><p>Signed on this phone when observed. Queued records keep their original time and ID while offline.</p><p>A control-room operator must <a href="/signin">sign in</a> on this phone before enrolling it, then return to /field/.</p><label>Exam ID<input id="exam" autocomplete="off"></label><label>Centre ID<input id="centre" autocomplete="off"></label><label>Person ID<input id="person" autocomplete="off"></label><button id="enrol">Enrol this phone</button><p id="device"></p></section><section><label>Package ID<input id="package" autocomplete="off"></label><label>Seal photo<input id="photo" type="file" accept="image/*" capture="environment"></label><label>QR code<input id="qr" type="file" accept="image/*" capture="environment"></label><label>Identifier read<input id="raw" autocomplete="off" placeholder="QR or NFC text"></label><button id="record">Record signed scan</button><p id="photo-status"></p></section><section><h2>Damaged label</h2><p>After trying both codes, retain a photo and request a control-room decision. The hand-off stays blocked until approved.</p><label>Leg ID<input id="leg" autocomplete="off"></label><label>Seam ID typed from label<input id="seam" autocomplete="off"></label><label>Printed serial<input id="serial" autocomplete="off"></label><label>Seconds spent trying both codes<input id="attempt-seconds" type="number" min="1" max="3600" value="10"></label><label>Unreadable codes<select id="codes"><option value="both">Both</option><option value="A">A</option><option value="B">B</option></select></label><button id="override">Request override using seal photo above</button><p id="override-status"></p></section><section><h2>Offline queue</h2><p id="queue-count"></p><button id="sync">Sync now</button><p id="status" role="status"></p><ul id="queued"></ul></section><section><h2>Photos on this phone</h2><p>Export these before clearing browser storage or replacing the phone.</p><ul id="photos"></ul></section>`;
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const label = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const say = (message: string) => { label("status").textContent = message; };

async function refresh() {
  label("online").textContent = navigator.onLine ? "online" : "offline";
  const identity = await get<Identity>("settings", "identity");
  label("device").textContent = identity ? `Device ${identity.deviceId}` : "Phone not enrolled. Enrol while online.";
  const queue = await all<Queued>("queue");
  label("queue-count").textContent = `${queue.length} record(s) waiting`;
  label("queued").replaceChildren(...queue.map((q) => { const li = document.createElement("li"); li.textContent = `${q.id}${q.error ? ` — ${q.error}` : ""}`; return li; }));
  const photos = await all<{ file: File; sha256: string; eventId: string }>("photos");
  label("photos").replaceChildren(...photos.map((p) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `Export ${p.eventId.slice(0, 8)}…`;
    button.onclick = () => {
      const url = URL.createObjectURL(p.file);
      const a = document.createElement("a");
    const ext = p.file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "image";
    a.href = url; a.download = `mohar-${p.eventId}-${p.sha256.slice(0, 12)}.${ext}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    li.append(button); return li;
  }));
}

async function enrol() {
  if (await get<Identity>("settings", "identity")) throw new Error("This phone is already enrolled");
  const examId = input("exam").value.trim(), centreId = input("centre").value.trim(), personId = input("person").value.trim();
  if (![examId, centreId, personId].every(validId)) throw new Error("Enter valid exam, centre and person IDs");
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pubkeyHex = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const response = await fetch("/api/devices", { method: "POST", headers: { "content-type": "application/json", ...operatorHeaders() }, body: JSON.stringify({ kind: "field", centreId, pubkeyHex }) });
  const data = await response.json() as { id?: string; error?: string };
  if (!response.ok || !data.id) throw new Error(response.status === 401 || response.status === 403 ? "Ask a control-room operator to sign in on this phone before enrolment" : data.error ?? `Enrolment returned ${response.status}`);
  await put("settings", pair.privateKey, "privateKey");
  await put("settings", { deviceId: data.id, examId, centreId, personId } satisfies Identity, "identity");
  await refresh();
}

async function photoHash(file: File): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

async function signedPost(path: string, body: Record<string, unknown>): Promise<Response> {
  const identity = await get<Identity>("settings", "identity");
  const key = await get<CryptoKey>("settings", "privateKey");
  if (!identity || !key) throw new Error("Enrol this phone first");
  const json = JSON.stringify({ ...body, deviceId: identity.deviceId });
  const timestamp = new Date().toISOString();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const signed = requestSigningBytes({ method: "POST", path, timestamp, nonce, body: new TextEncoder().encode(json) });
  const signature = hex(await crypto.subtle.sign("Ed25519", key, Uint8Array.from(signed)));
  return fetch(`/api${path}`, { method: "POST", headers: {
    "content-type": "application/json",
    [REQUEST_SIGNATURE_HEADERS.device]: identity.deviceId,
    [REQUEST_SIGNATURE_HEADERS.timestamp]: timestamp,
    [REQUEST_SIGNATURE_HEADERS.nonce]: nonce,
    [REQUEST_SIGNATURE_HEADERS.signature]: signature,
  }, body: json });
}

async function requestOverride() {
  if (!navigator.onLine) throw new Error("A damaged-label request needs a live control-room connection");
  const identity = await get<Identity>("settings", "identity");
  if (!identity) throw new Error("Enrol this phone first");
  const legId = input("leg").value.trim();
  if (!validId(legId)) throw new Error("Enter a valid leg ID");
  const seamIdTyped = input("seam").value.trim();
  if (!seamIdTyped) throw new Error("Type the seam ID still visible on the label");
  const photo = input("photo").files?.[0];
  if (!photo) throw new Error("Take the damaged-label photograph first");
  const attemptedSeconds = Number(input("attempt-seconds").value);
  if (!Number.isInteger(attemptedSeconds) || attemptedSeconds < 1 || attemptedSeconds > 3600) throw new Error("Enter seconds spent trying the codes");
  const photoSha256 = await photoHash(photo);
  const localId = `override-${crypto.randomUUID()}`;
  await put("photos", { file: photo, sha256: photoSha256, eventId: localId, storedAt: new Date().toISOString() }, localId);
  const response = await signedPost(`/legs/${legId}/override`, {
    personId: identity.personId, seamIdTyped, serialTyped: input("serial").value.trim() || undefined,
    attemptedSeconds, whichCodes: input("codes").value, photoSha256,
  });
  const data = await response.json() as { overrideId?: string; error?: string };
  if (!response.ok || !data.overrideId) throw new Error(data.error ?? `Override request returned ${response.status}`);
  label("override-status").textContent = `Request ${data.overrideId} sent. Wait for two control-room decisions before continuing the hand-off.`;
  await refresh();
}

async function decodeQr(file: File): Promise<string> {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  image.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(pixels.data, pixels.width, pixels.height)?.data ?? "";
}

async function record() {
  const identity = await get<Identity>("settings", "identity");
  const key = await get<CryptoKey>("settings", "privateKey");
  if (!identity || !key) throw new Error("Enrol this phone first");
  const packageId = input("package").value.trim();
  if (!validId(packageId)) throw new Error("Enter a valid package ID");
  const photo = input("photo").files?.[0];
  if (!photo) throw new Error("Take the seal photograph first");
  const digest = await photoHash(photo);
  let raw = input("raw").value.trim();
  const qr = input("qr").files?.[0];
  if (qr) raw = await decodeQr(qr) || raw;
  if (!raw || raw.length > 256) throw new Error("Scan a QR or enter its identifier");
  const id = crypto.randomUUID();
  const body = { v: 1, id, examId: identity.examId, centreId: identity.centreId, packageId,
    occurredAt: new Date().toISOString(), actorDeviceId: identity.deviceId, actorPersonId: identity.personId,
    kind: "SCAN_OBSERVED", payload: { scanType: "qr", rawIdentifier: raw, photoSha256: digest } };
  const signature = await crypto.subtle.sign("Ed25519", key, Uint8Array.from(canonicalBytes(body)));
  await put("photos", { file: photo, sha256: digest, eventId: id, storedAt: new Date().toISOString() }, id);
  await put("queue", { id, signed: { body, deviceSig: hex(signature) } } satisfies Queued);
  label("photo-status").textContent = `Photo retained on this phone. SHA-256 ${digest}`;
  input("raw").value = ""; input("qr").value = ""; input("photo").value = "";
  await refresh();
  if (navigator.onLine) await sync();
}

async function sync() {
  const queue = await all<Queued>("queue");
  for (const item of queue) {
    if (item.error) continue;
    let response: Response;
    try { response = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item.signed) }); }
    catch { say("Network unavailable. Signed records remain queued."); break; }
    if (response.status === 200 || response.status === 201) { await remove("queue", item.id); continue; }
    if (response.status === 422) {
      const detail = await response.text();
      await put("queue", { ...item, error: `Ledger rejected: ${detail.slice(0, 200)}` });
      continue;
    }
    say(`Server returned ${response.status}. Remaining records stay queued.`);
    break;
  }
  await refresh();
}

function run(action: () => Promise<void>) { void action().catch((err: unknown) => say((err as Error).message)); }
label("enrol").addEventListener("click", () => run(enrol));
label("record").addEventListener("click", () => run(record));
label("override").addEventListener("click", () => run(requestOverride));
label("sync").addEventListener("click", () => run(sync));
addEventListener("online", () => { void refresh(); run(sync); });
addEventListener("offline", () => { void refresh(); });
void refresh();
if (navigator.serviceWorker) void navigator.serviceWorker.register("/field/sw.js");
