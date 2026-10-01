import { canonicalBytes } from "@mohar/crypto-core";
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
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join("");
const validId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `<header><strong>Mohar Field</strong><span id="online"></span></header><section><h1>Courier scan</h1><p>Signed on this phone when observed. Queued records keep their original time and ID while offline.</p><p>A control-room operator must <a href="/signin">sign in</a> on this phone before enrolling it, then return to /field/.</p><label>Exam ID<input id="exam" autocomplete="off"></label><label>Centre ID<input id="centre" autocomplete="off"></label><label>Person ID<input id="person" autocomplete="off"></label><button id="enrol">Enrol this phone</button><p id="device"></p></section><section><label>Package ID<input id="package" autocomplete="off"></label><label>Seal photo<input id="photo" type="file" accept="image/*" capture="environment"></label><label>QR code<input id="qr" type="file" accept="image/*" capture="environment"></label><label>Identifier read<input id="raw" autocomplete="off" placeholder="QR or NFC text"></label><button id="record">Record signed scan</button><p id="photo-status"></p></section><section><h2>Offline queue</h2><p id="queue-count"></p><button id="sync">Sync now</button><p id="status" role="status"></p><ul id="queued"></ul></section><section><h2>Photos on this phone</h2><p>Export these before clearing browser storage or replacing the phone.</p><ul id="photos"></ul></section>`;
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
label("sync").addEventListener("click", () => run(sync));
addEventListener("online", () => { void refresh(); run(sync); });
addEventListener("offline", () => { void refresh(); });
void refresh();
if (navigator.serviceWorker) void navigator.serviceWorker.register("/field/sw.js");
