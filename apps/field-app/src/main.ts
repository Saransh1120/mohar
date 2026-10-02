import { canonicalBytes, combineScannedPair, parseSeamQr, requestSigningBytes, REQUEST_SIGNATURE_HEADERS } from "@mohar/crypto-core";
import jsQR from "jsqr";
import "./style.css";

interface Identity { deviceId: string; examId: string; centreId: string; personId: string; }
interface Queued { id: string; signed: { body: Record<string, unknown>; deviceSig: string }; error?: string; }
interface Leg { id: string; leg_no: number; from_role: string; to_role: string; dispatched: boolean; completed: boolean; key_issued_at: string | null; refused_attempts: number; overdue: boolean; }
interface TransferCheck { check: string; passed?: boolean; evidence: string; reason?: string; }
interface ChainEvent { recorded: boolean; kind: string; eventId?: string; reason?: string; }
interface TransferResult { outcome: "granted" | "refused"; step: "dispatch" | "receive" | "confirm"; checks: TransferCheck[]; denyReasons: string[]; attemptNo: number; chainEvent?: ChainEvent; chainEvents?: ChainEvent[]; transferKey?: string; keyFingerprint?: string; }
const DB = "mohar-field-v1";

/**
 * Enrolling a device is a control-room operator's act, so the operator types
 * their own username and password here, once. The session that yields is used
 * for the enrolment and ended in the same breath: it is never written to this
 * phone's storage. A courier's phone that kept an operator's session could
 * issue custody keys for twelve hours.
 */
async function withOperator<T>(username: string, password: string, action: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const signIn = await fetch("/api/auth/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  const session = await signIn.json().catch(() => ({})) as { token?: string; account?: { role?: string }; error?: string };
  if (!signIn.ok || !session.token) throw new Error(session.error ?? `Operator sign-in returned ${signIn.status}`);
  const headers = { authorization: `Bearer ${session.token}` };
  try {
    if (session.account?.role !== "control_room") throw new Error("Enrolling a phone takes a control-room operator's account");
    return await action(headers);
  } finally {
    await fetch("/api/auth/signout", { method: "POST", headers }).catch(() => undefined);
  }
}

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

/** Reserve in one read/write transaction before the event is signed or queued. */
async function reserveDeviceSeq(deviceId: string): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const settings = tx.objectStore("settings");
    const key = `deviceSeq:${deviceId}`;
    const read = settings.get(key);
    let next = 0;
    read.onsuccess = () => {
      const previous: unknown = read.result;
      if (previous !== undefined && (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0)) {
        tx.abort();
        return;
      }
      next = Number(previous ?? 0) + 1;
      if (!Number.isSafeInteger(next)) { tx.abort(); return; }
      settings.put(next, key);
    };
    tx.oncomplete = () => { db.close(); resolve(next); };
    tx.onabort = () => { db.close(); reject(new Error("Could not reserve a valid device sequence number")); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `<header><strong>Mohar Field</strong><span id="online"></span></header><section><h1>Courier scan</h1><p>Signed on this phone when observed. Queued records keep their original time and ID while offline.</p><p>A control-room operator enrols this phone by entering their own username and password below. They are used once, for the enrolment, and the session is ended straight away: nothing of the operator's stays on this phone.</p><label>Exam ID<input id="exam" autocomplete="off"></label><label>Centre ID<input id="centre" autocomplete="off"></label><label>Person ID<input id="person" autocomplete="off"></label><label>Operator username<input id="op-user" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>Operator password<input id="op-pass" type="password" autocomplete="off"></label><button id="enrol">Enrol this phone</button><p id="device"></p><p id="enrol-status" role="status"></p></section><section><label>Package ID<input id="package" autocomplete="off"></label><label>Seal photo<input id="photo" type="file" accept="image/*" capture="environment"></label><label>QR code<input id="qr" type="file" accept="image/*" capture="environment"></label><label>Identifier read<input id="raw" autocomplete="off" placeholder="QR or NFC text"></label><button id="record">Record signed scan</button><p id="photo-status"></p></section><section><h2>Hand-off</h2><p>These three steps are signed by this enrolled phone. This browser has no fingerprint reader: the selected slot and score are simulated, not biometric proof.</p><button id="load-legs">Load legs for package above</button><label>Leg<select id="handoff-leg"></select></label><ul id="leg-list"></ul><label>QR A image<input id="handoff-qr-a" type="file" accept="image/*" capture="environment"></label><label>QR B image<input id="handoff-qr-b" type="file" accept="image/*" capture="environment"></label><label>Simulated fingerprint<select id="fingerprint"><option value="match">Simulated match (slot 3, score 180)</option><option value="mismatch">Simulated mismatch (slot 3, score 40)</option><option value="none">Not read</option></select></label><label>Packet serial typed by receiver<input id="handoff-serial" autocomplete="off"></label><label>Approved damaged-label override ID (in place of both QR scans)<input id="handoff-override" autocomplete="off"></label><button id="dispatch">Dispatch</button> <button id="receive">Receive</button> <button id="confirm">Confirm with key held in memory</button><p id="handoff-key"></p><div id="handoff-result" role="status"></div></section><section><h2>Damaged label</h2><p>After trying both codes, retain a photo and request a control-room decision. The hand-off stays blocked until approved.</p><label>Leg ID<input id="leg" autocomplete="off"></label><label>Seam ID typed from label<input id="seam" autocomplete="off"></label><label>Printed serial<input id="serial" autocomplete="off"></label><label>Seconds spent trying both codes<input id="attempt-seconds" type="number" min="1" max="3600" value="10"></label><label>Unreadable codes<select id="codes"><option value="both">Both</option><option value="A">A</option><option value="B">B</option></select></label><button id="override">Request override using seal photo above</button><p id="override-status"></p></section><section><h2>Offline queue</h2><p id="queue-count"></p><button id="sync">Sync now</button><p id="status" role="status"></p><ul id="queued"></ul></section><section><h2>Photos on this phone</h2><p>Export these before clearing browser storage or replacing the phone.</p><ul id="photos"></ul></section>`;
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const label = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const say = (message: string) => { label("status").textContent = message; };

async function refresh() {
  label("online").textContent = navigator.onLine ? "online" : "offline";
  const identity = await get<Identity>("settings", "identity");
  label("device").textContent = identity ? `Device ${identity.deviceId}` : "Phone not enrolled. Enrol while online.";
  const queue = await all<Queued>("queue");
  // A rejected record is not waiting for anything: it stays so that it can be
  // seen, and is counted apart from the ones that will be sent.
  const rejected = queue.filter((q) => q.error).length;
  label("queue-count").textContent = `${queue.length - rejected} record(s) waiting to be sent` + (rejected ? `, ${rejected} rejected and kept` : "");
  label("queued").replaceChildren(...queue.map((q) => { const li = document.createElement("li"); li.textContent = `${q.id}${q.error ? ` — ${q.error}` : ""}`; return li; }));
  const photos = await all<{ file: File; sha256: string; eventId: string }>("photos");
  label("photos").replaceChildren(...photos.map((p) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = p.eventId.startsWith("override-")
      ? `Export damaged-label photo ${p.eventId.slice(9, 17)}…`
      : `Export seal photo ${p.eventId.slice(0, 8)}…`;
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
  const username = input("op-user").value.trim(), password = input("op-pass").value;
  if (!username || !password) throw new Error("A control-room operator enters their username and password to enrol this phone");
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pubkeyHex = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const deviceId = await withOperator(username, password, async (headers) => {
    // Every event this phone signs names these three. One that the ledger does
    // not know would be refused later, in the field, with nobody to fix it: so
    // they are checked now, while the operator is here.
    const list = async <T>(path: string): Promise<T> => {
      const res = await fetch(`/api${path}`, { headers });
      if (!res.ok) throw new Error(`Could not read ${path.split("?")[0]} (${res.status})`);
      return await res.json() as T;
    };
    const { centres } = await list<{ centres: { id: string; examId: string }[] }>(`/centres?examId=${examId}`);
    if (!centres.some((c) => c.id === centreId)) throw new Error("That centre is not a centre of that exam");
    const { persons } = await list<{ persons: { id: string }[] }>("/persons");
    if (!persons.some((p) => p.id === personId)) throw new Error("No person on the register has that ID");
    const response = await fetch("/api/devices", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ kind: "field", centreId, pubkeyHex }) });
    const data = await response.json().catch(() => ({})) as { id?: string; error?: string };
    if (!response.ok || !data.id) throw new Error(data.error ?? `Enrolment returned ${response.status}`);
    return data.id;
  });
  await put("settings", pair.privateKey, "privateKey");
  await put("settings", { deviceId, examId, centreId, personId } satisfies Identity, "identity");
  input("op-user").value = ""; input("op-pass").value = "";
  label("enrol-status").textContent = "Enrolled. The operator's session has been ended.";
  await refresh();
}

async function photoHash(file: File): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

async function signedRequest(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Response> {
  const identity = await get<Identity>("settings", "identity");
  const key = await get<CryptoKey>("settings", "privateKey");
  if (!identity || !key) throw new Error("Enrol this phone first");
  const json = method === "POST" ? JSON.stringify({ ...body, deviceId: identity.deviceId }) : "";
  const timestamp = new Date().toISOString();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const signed = requestSigningBytes({ method, path, timestamp, nonce, body: new TextEncoder().encode(json) });
  const signature = hex(await crypto.subtle.sign("Ed25519", key, Uint8Array.from(signed)));
  return fetch(`/api${path}`, { method, headers: {
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
    [REQUEST_SIGNATURE_HEADERS.device]: identity.deviceId,
    [REQUEST_SIGNATURE_HEADERS.timestamp]: timestamp,
    [REQUEST_SIGNATURE_HEADERS.nonce]: nonce,
    [REQUEST_SIGNATURE_HEADERS.signature]: signature,
  }, ...(method === "POST" ? { body: json } : {}) });
}
const signedPost = (path: string, body: Record<string, unknown>) => signedRequest("POST", path, body);

// The issued key is a one-response secret. It is never put in DOM, IndexedDB,
// localStorage, a console message or a queued request.
let heldTransferKey: string | null = null;
let heldLegId: string | null = null;

async function loadLegs(showStatus = true) {
  const packageId = input("package").value.trim();
  if (!validId(packageId)) throw new Error("Enter the package ID above first");
  const response = await signedRequest("GET", `/legs?packageId=${encodeURIComponent(packageId)}`);
  const data = await response.json() as { legs?: Leg[]; error?: string };
  if (!response.ok || !data.legs) throw new Error(data.error ?? `Leg list returned ${response.status}`);
  const select = document.querySelector<HTMLSelectElement>("#handoff-leg")!;
  select.replaceChildren(...data.legs.map((leg) => {
    const option = document.createElement("option");
    option.value = leg.id;
    option.textContent = `${leg.leg_no}: ${leg.from_role} → ${leg.to_role} (${leg.id.slice(0, 8)})`;
    return option;
  }));
  label("leg-list").replaceChildren(...data.legs.map((leg) => {
    const item = document.createElement("li");
    item.textContent = `Leg ${leg.leg_no}: ${leg.from_role} → ${leg.to_role}; dispatched ${leg.dispatched}; key issued ${Boolean(leg.key_issued_at)}; completed ${leg.completed}; refused attempts ${leg.refused_attempts}; overdue ${leg.overdue}`;
    return item;
  }));
  if (showStatus) label("handoff-result").textContent = `${data.legs.length} leg(s) returned by ledger.`;
}

async function handoff(step: "dispatch" | "receive" | "confirm") {
  if (!navigator.onLine) throw new Error("A hand-off needs a live connection to the engine");
  const identity = await get<Identity>("settings", "identity");
  if (!identity) throw new Error("Enrol this phone first");
  const legId = document.querySelector<HTMLSelectElement>("#handoff-leg")!.value;
  if (!validId(legId)) throw new Error("Load and choose a leg first");
  const body: Record<string, unknown> = { personId: identity.personId, occurredAt: new Date().toISOString() };
  if (step !== "confirm") {
    const overrideId = input("handoff-override").value.trim();
    if (overrideId) {
      if (!validId(overrideId)) throw new Error("Override ID must be a UUID");
      body.overrideId = overrideId;
    } else {
      const a = input("handoff-qr-a").files?.[0];
      const b = input("handoff-qr-b").files?.[0];
      if (!a || !b) throw new Error("Scan both QR codes or enter an approved override ID");
      const pair = combineScannedPair(parseSeamQr(await decodeQr(a)), parseSeamQr(await decodeQr(b)));
      body.seamIdRead = pair.seamId;
      body.seamSecretHex = hex(pair.seamSecret.slice().buffer);
    }
  }
  const finger = document.querySelector<HTMLSelectElement>("#fingerprint")!.value;
  if (finger !== "none") {
    body.biometricSlot = 3;
    body.biometricScore = finger === "match" ? 180 : 40;
  }
  if (step === "receive") body.packetSerialTyped = input("handoff-serial").value.trim();
  if (step === "confirm") {
    if (!heldTransferKey || heldLegId !== legId) throw new Error("No transfer key held for this leg. It is only available in a granted receive response.");
    body.transferKey = heldTransferKey;
  }
  const response = await signedPost(`/legs/${legId}/${step}`, body);
  const data = await response.json() as TransferResult & { error?: string; detail?: string };
  if (!response.ok) throw new Error(data.error ?? data.detail ?? `Hand-off returned ${response.status}`);
  const result = label("handoff-result");
  result.replaceChildren();
  const summary = document.createElement("p");
  summary.textContent = `${data.step}: ${data.outcome}; attempt ${data.attemptNo}; deny reasons: ${data.denyReasons.join(", ") || "none"}`;
  result.append(summary);
  const checks = document.createElement("ul");
  for (const check of data.checks) {
    const row = document.createElement("li");
    row.className = check.passed === true ? "pass" : check.passed === false ? "fail" : "skip";
    row.textContent = `${check.check}: ${check.passed === true ? "passed" : check.passed === false ? "failed" : "not evaluated"} — ${check.evidence}${check.reason ? ` (${check.reason})` : ""}`;
    checks.append(row);
  }
  result.append(checks);
  const chainEvents = data.chainEvents ?? (data.chainEvent ? [data.chainEvent] : []);
  if (chainEvents.length === 0) {
    const chain = document.createElement("p");
    chain.textContent = "Chain event: not returned by engine for this step";
    result.append(chain);
  }
  for (const event of chainEvents) {
    const chain = document.createElement("p");
    chain.textContent = `Chain event ${event.kind}: ${event.recorded ? `recorded ${event.eventId ?? ""}` : `not recorded — ${event.reason ?? "no reason returned"}`}`;
    result.append(chain);
  }
  if (data.outcome === "granted" && step === "receive" && data.transferKey) {
    heldTransferKey = data.transferKey;
    heldLegId = legId;
    label("handoff-key").textContent = `Transfer key held in memory for leg ${legId.slice(0, 8)}. It will be sent by Confirm and lost if this page closes.`;
  }
  if (data.outcome === "granted" && step === "confirm") {
    heldTransferKey = null;
    heldLegId = null;
    label("handoff-key").textContent = "Transfer key consumed and cleared from memory.";
  }
  if (step === "receive" && data.outcome === "refused") {
    heldTransferKey = null;
    heldLegId = null;
  }
  await loadLegs(false);
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
  const deviceSeq = await reserveDeviceSeq(identity.deviceId);
  const body = { v: 1, id, examId: identity.examId, centreId: identity.centreId, packageId,
    occurredAt: new Date().toISOString(), actorDeviceId: identity.deviceId, actorPersonId: identity.personId,
    deviceSeq,
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
  // What the last attempt said is not what this one will find.
  say("");
  let sent = 0;
  for (const item of queue) {
    if (item.error) continue;
    let response: Response;
    try { response = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item.signed) }); }
    catch { say("Network unavailable. Signed records remain queued."); break; }
    if (response.status === 200 || response.status === 201) {
      await remove("queue", item.id);
      sent += 1;
      say(`${sent} record(s) accepted by the ledger.`);
      continue;
    }
    // 422 is the ledger saying the event cannot be authenticated; 401 is the
    // gateway saying the same thing before the ledger saw it (the device is
    // unknown or revoked, or the signature does not verify). Neither will
    // change on a retry, so the record is kept, marked, and the queue moves on.
    if (response.status === 422 || response.status === 401) {
      const detail = await response.text();
      await put("queue", { ...item, error: `${response.status === 422 ? "Ledger" : "Gateway"} rejected: ${detail.slice(0, 200)}` });
      continue;
    }
    if (response.status === 429) {
      say(`The gateway is limiting this phone. Retry in ${response.headers.get("retry-after") ?? "a few"} s; records stay queued.`);
      break;
    }
    say(`Server returned ${response.status}. Remaining records stay queued.`);
    break;
  }
  await refresh();
}

// A failure is said beside the button that was pressed, not at the foot of the page.
function run(action: () => Promise<void>, where = "status") {
  void action().catch((err: unknown) => { label(where).textContent = (err as Error).message; });
}
label("enrol").addEventListener("click", () => run(enrol, "enrol-status"));
label("record").addEventListener("click", () => run(record, "photo-status"));
label("load-legs").addEventListener("click", () => run(loadLegs, "handoff-result"));
for (const step of ["dispatch", "receive", "confirm"] as const) {
  label(step).addEventListener("click", () => run(() => handoff(step), "handoff-result"));
}
label("override").addEventListener("click", () => run(requestOverride, "override-status"));
label("sync").addEventListener("click", () => run(sync));
addEventListener("online", () => { void refresh(); run(sync); });
addEventListener("offline", () => { void refresh(); });
void refresh();
if (navigator.serviceWorker) void navigator.serviceWorker.register("/field/sw.js");
