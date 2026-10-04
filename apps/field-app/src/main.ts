import { canonicalBytes, combineScannedPair, parseSeamQr, requestSigningBytes, REQUEST_SIGNATURE_HEADERS } from "@mohar/crypto-core";
import jsQR from "jsqr";
import { applyLanguage, languageButton, t } from "./i18n";
import { createPlatformCredential, getPlatformAssertion, platformAvailable } from "./webauthn";
import "./style.css";

interface Identity { deviceId: string; examId: string; centreId: string; personId: string; webauthnEnrolled?: boolean; }
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
  if (!signIn.ok || !session.token) throw new Error(session.error ?? t("e_signin", { status: signIn.status }));
  const headers = { authorization: `Bearer ${session.token}` };
  try {
    if (session.account?.role !== "control_room") throw new Error(t("e_need_control_room"));
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
    tx.onabort = () => { db.close(); reject(new Error(t("e_seq"))); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `<header><strong>Mohar Field</strong><span><span id="online"></span> <span id="lang"></span></span></header><section><h1 data-i18n="h_scan"></h1><p data-i18n="p_signed"></p><p data-i18n="p_enrol"></p><label><span data-i18n="l_exam"></span><input id="exam" autocomplete="off"></label><label><span data-i18n="l_centre"></span><input id="centre" autocomplete="off"></label><label><span data-i18n="l_person"></span><input id="person" autocomplete="off"></label><label><span data-i18n="l_op_user"></span><input id="op-user" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label><span data-i18n="l_op_pass"></span><input id="op-pass" type="password" autocomplete="off"></label><label><input id="replace-cred" type="checkbox" style="display:inline;width:auto;margin-right:8px"><span data-i18n="l_replace_cred" style="display:inline"></span></label><button id="enrol" data-i18n="b_enrol"></button><p id="device"></p><p id="enrol-status" role="status"></p></section><section><label><span data-i18n="l_package"></span><input id="package" autocomplete="off"></label><label><span data-i18n="l_photo"></span><input id="photo" type="file" accept="image/*" capture="environment"></label><label><span data-i18n="l_qr"></span><input id="qr" type="file" accept="image/*" capture="environment"></label><label><span data-i18n="l_raw"></span><input id="raw" autocomplete="off" data-i18n-placeholder="ph_raw"></label><button id="record" data-i18n="b_record"></button><p id="photo-status"></p></section><section><h2 data-i18n="h_handoff"></h2><p data-i18n="p_handoff"></p><p data-i18n="p_engine_words"></p><button id="load-legs" data-i18n="b_load_legs"></button><label><span data-i18n="l_leg"></span><select id="handoff-leg"></select></label><ul id="leg-list"></ul><label><span data-i18n="l_qr_a"></span><input id="handoff-qr-a" type="file" accept="image/*" capture="environment"></label><label><span data-i18n="l_qr_b"></span><input id="handoff-qr-b" type="file" accept="image/*" capture="environment"></label><label><span data-i18n="l_finger"></span><select id="fingerprint"><option value="match" data-i18n="o_match"></option><option value="mismatch" data-i18n="o_mismatch"></option><option value="none" data-i18n="o_none"></option></select></label><label><span data-i18n="l_serial_recv"></span><input id="handoff-serial" autocomplete="off"></label><label><span data-i18n="l_override_id"></span><input id="handoff-override" autocomplete="off"></label><button id="dispatch" data-i18n="b_dispatch"></button> <button id="receive" data-i18n="b_receive"></button> <button id="confirm" data-i18n="b_confirm"></button><p id="handoff-key"></p><div id="handoff-result" role="status"></div></section><section><h2 data-i18n="h_damaged"></h2><p data-i18n="p_damaged"></p><label><span data-i18n="l_leg_id"></span><input id="leg" autocomplete="off"></label><label><span data-i18n="l_seam"></span><input id="seam" autocomplete="off"></label><label><span data-i18n="l_serial"></span><input id="serial" autocomplete="off"></label><label><span data-i18n="l_seconds"></span><input id="attempt-seconds" type="number" min="1" max="3600" value="10"></label><label><span data-i18n="l_codes"></span><select id="codes"><option value="both" data-i18n="o_both"></option><option value="A">A</option><option value="B">B</option></select></label><button id="override" data-i18n="b_override"></button><p id="override-status"></p></section><section><h2 data-i18n="h_queue"></h2><p id="queue-count"></p><button id="sync" data-i18n="b_sync"></button><p id="status" role="status"></p><ul id="queued"></ul></section><section><h2 data-i18n="h_photos"></h2><p data-i18n="p_photos"></p><ul id="photos"></ul></section>`;
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const label = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
const say = (message: string) => { label("status").textContent = message; };
// Changing language rewrites the fixed lines in place and refreshes the lists.
// Nothing is reloaded, so a transfer key held in memory is not lost by it.
label("lang").append(languageButton(() => { void refresh(); }));
applyLanguage();

async function refresh() {
  label("online").textContent = t(navigator.onLine ? "online" : "offline");
  const identity = await get<Identity>("settings", "identity");
  label("device").textContent = identity
    ? `${t("device", { id: identity.deviceId })} — ${t(identity.webauthnEnrolled ? "platform_enrolled" : "simulated_only")}`
    : t("not_enrolled");
  const queue = await all<Queued>("queue");
  // A rejected record is not waiting for anything: it stays so that it can be
  // seen, and is counted apart from the ones that will be sent.
  const rejected = queue.filter((q) => q.error).length;
  label("queue-count").textContent = t("queue_count", { n: queue.length - rejected }) + (rejected ? t("queue_rejected", { n: rejected }) : "");
  label("queued").replaceChildren(...queue.map((q) => { const li = document.createElement("li"); li.textContent = `${q.id}${q.error ? ` — ${q.error}` : ""}`; return li; }));
  const photos = await all<{ file: File; sha256: string; eventId: string }>("photos");
  label("photos").replaceChildren(...photos.map((p) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = p.eventId.startsWith("override-")
      ? t("export_damaged", { id: p.eventId.slice(9, 17) })
      : t("export_seal", { id: p.eventId.slice(0, 8) });
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
  if (await get<Identity>("settings", "identity")) throw new Error(t("e_already_enrolled"));
  const examId = input("exam").value.trim(), centreId = input("centre").value.trim(), personId = input("person").value.trim();
  if (![examId, centreId, personId].every(validId)) throw new Error(t("e_ids_invalid"));
  const username = input("op-user").value.trim(), password = input("op-pass").value;
  if (!username || !password) throw new Error(t("e_need_operator"));
  const replace = input("replace-cred").checked;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pubkeyHex = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  const enrolled = await withOperator(username, password, async (headers) => {
    // Every event this phone signs names these three. One that the ledger does
    // not know would be refused later, in the field, with nobody to fix it: so
    // they are checked now, while the operator is here.
    const list = async <T>(path: string): Promise<T> => {
      const res = await fetch(`/api${path}`, { headers });
      if (!res.ok) throw new Error(t("e_cannot_read", { what: path.split("?")[0] ?? path, status: res.status }));
      return await res.json() as T;
    };
    const { centres } = await list<{ centres: { id: string; examId: string }[] }>(`/centres?examId=${examId}`);
    if (!centres.some((c) => c.id === centreId)) throw new Error(t("e_centre_not_of_exam"));
    const { persons } = await list<{ persons: { id: string }[] }>("/persons");
    if (!persons.some((p) => p.id === personId)) throw new Error(t("e_person_unknown"));
    const hasPlatform = await platformAvailable();
    if (hasPlatform) {
      const challengeResponse = await fetch("/api/webauthn/register/challenge", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ personId, ...(replace ? { replace: true } : {}) }),
      });
      const challenge = await challengeResponse.json() as { challengeId?: string; options?: Parameters<typeof createPlatformCredential>[0]; error?: string };
      // This person already has a credential, from another phone or from an
      // enrolment that stopped half way. Replacing it is the operator's call.
      if (challengeResponse.status === 409 && !replace) throw new Error(t("e_platform_exists"));
      if (!challengeResponse.ok || !challenge.options || !challenge.challengeId) throw new Error(challenge.error ?? t("e_platform_register"));
      const credential = await createPlatformCredential(challenge.options);
      const completeResponse = await fetch("/api/webauthn/register/complete", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ personId, challengeId: challenge.challengeId, response: credential, ...(replace ? { replace: true } : {}) }),
      });
      if (!completeResponse.ok) {
        const detail = await completeResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error ?? t("e_platform_register"));
      }
    }
    const response = await fetch("/api/devices", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ kind: "field", centreId, pubkeyHex }) });
    const data = await response.json().catch(() => ({})) as { id?: string; error?: string };
    if (!response.ok || !data.id) throw new Error(data.error ?? t("e_enrol", { status: response.status }));
    return { deviceId: data.id, hasPlatform };
  });
  await put("settings", pair.privateKey, "privateKey");
  await put("settings", { deviceId: enrolled.deviceId, examId, centreId, personId, webauthnEnrolled: enrolled.hasPlatform } satisfies Identity, "identity");
  input("op-user").value = ""; input("op-pass").value = "";
  label("enrol-status").textContent = t("enrolled");
  await refresh();
}

async function photoHash(file: File): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

async function signedRequest(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Response> {
  const identity = await get<Identity>("settings", "identity");
  const key = await get<CryptoKey>("settings", "privateKey");
  if (!identity || !key) throw new Error(t("e_enrol_first"));
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
  if (!validId(packageId)) throw new Error(t("e_need_package"));
  const response = await signedRequest("GET", `/legs?packageId=${encodeURIComponent(packageId)}`);
  const data = await response.json() as { legs?: Leg[]; error?: string };
  if (!response.ok || !data.legs) throw new Error(data.error ?? t("e_legs", { status: response.status }));
  const select = document.querySelector<HTMLSelectElement>("#handoff-leg")!;
  select.replaceChildren(...data.legs.map((leg) => {
    const option = document.createElement("option");
    option.value = leg.id;
    option.textContent = t("leg_option", { no: leg.leg_no, from: leg.from_role, to: leg.to_role, id: leg.id.slice(0, 8) });
    return option;
  }));
  label("leg-list").replaceChildren(...data.legs.map((leg) => {
    const item = document.createElement("li");
    const yn = (v: boolean) => t(v ? "yes" : "no");
    item.textContent = t("leg_line", {
      no: leg.leg_no, from: leg.from_role, to: leg.to_role, dispatched: yn(leg.dispatched),
      key: yn(Boolean(leg.key_issued_at)), completed: yn(leg.completed), refused: leg.refused_attempts, overdue: yn(leg.overdue),
    });
    return item;
  }));
  if (showStatus) label("handoff-result").textContent = t("legs_returned", { n: data.legs.length });
}

async function handoff(step: "dispatch" | "receive" | "confirm") {
  if (!navigator.onLine) throw new Error(t("e_need_live"));
  const identity = await get<Identity>("settings", "identity");
  if (!identity) throw new Error(t("e_enrol_first"));
  const legId = document.querySelector<HTMLSelectElement>("#handoff-leg")!.value;
  if (!validId(legId)) throw new Error(t("e_choose_leg"));
  const body: Record<string, unknown> = { personId: identity.personId, occurredAt: new Date().toISOString() };
  const overrideId = input("handoff-override").value.trim();
  if (overrideId) {
    if (!validId(overrideId)) throw new Error(t("e_override_uuid"));
    body.overrideId = overrideId;
  } else {
    const a = input("handoff-qr-a").files?.[0];
    const b = input("handoff-qr-b").files?.[0];
    if (!a || !b) throw new Error(t("e_need_qr"));
    const pair = combineScannedPair(parseSeamQr(await decodeQr(a)), parseSeamQr(await decodeQr(b)));
    body.seamIdRead = pair.seamId;
    body.seamSecretHex = hex(pair.seamSecret.slice().buffer);
  }
  const finger = document.querySelector<HTMLSelectElement>("#fingerprint")!.value;
  if (finger !== "none") {
    body.biometricSlot = 3;
    body.biometricScore = finger === "match" ? 180 : 40;
  }
  if (step === "receive") body.packetSerialTyped = input("handoff-serial").value.trim();
  if (step === "confirm") {
    if (!heldTransferKey || heldLegId !== legId) throw new Error(t("e_no_key"));
    body.transferKey = heldTransferKey;
  }
  if (identity.webauthnEnrolled) {
    if (!await platformAvailable()) throw new Error(t("e_platform_unavailable"));
    const challengeResponse = await signedPost(`/legs/${legId}/${step}/webauthn/challenge`, { personId: identity.personId });
    const challenge = await challengeResponse.json() as { challengeId?: string; options?: Parameters<typeof getPlatformAssertion>[0]; error?: string };
    if (!challengeResponse.ok || !challenge.challengeId || !challenge.options) throw new Error(challenge.error ?? t("e_platform_challenge"));
    body.webauthn = { challengeId: challenge.challengeId, response: await getPlatformAssertion(challenge.options) };
  }
  const response = await signedPost(`/legs/${legId}/${step}`, body);
  const data = await response.json() as TransferResult & { error?: string; detail?: string };
  if (!response.ok) throw new Error(data.error ?? data.detail ?? t("e_handoff", { status: response.status }));
  const result = label("handoff-result");
  result.replaceChildren();
  const summary = document.createElement("p");
  // The step and the outcome are said in the reader's language. The deny
  // reasons and the checks under them are the engine's own words.
  summary.textContent = t("summary", {
    step: t(`step_${data.step}`), outcome: t(`outcome_${data.outcome}`), n: data.attemptNo,
    reasons: data.denyReasons.join(", ") || t("none"),
  });
  result.append(summary);
  const checks = document.createElement("ul");
  for (const check of data.checks) {
    const row = document.createElement("li");
    row.className = check.passed === true ? "pass" : check.passed === false ? "fail" : "skip";
    row.textContent = `${check.check}: ${t(check.passed === true ? "check_passed" : check.passed === false ? "check_failed" : "check_skipped")} — ${check.evidence}${check.reason ? ` (${check.reason})` : ""}`;
    checks.append(row);
  }
  result.append(checks);
  const chainEvents = data.chainEvents ?? (data.chainEvent ? [data.chainEvent] : []);
  if (chainEvents.length === 0) {
    const chain = document.createElement("p");
    chain.textContent = t("chain_none");
    result.append(chain);
  }
  for (const event of chainEvents) {
    const chain = document.createElement("p");
    chain.textContent = event.recorded
      ? t("chain_recorded", { kind: event.kind, id: event.eventId ?? "" })
      : t("chain_not_recorded", { kind: event.kind, reason: event.reason ?? t("no_reason") });
    result.append(chain);
  }
  if (data.outcome === "granted" && step === "receive" && data.transferKey) {
    heldTransferKey = data.transferKey;
    heldLegId = legId;
    label("handoff-key").textContent = t("key_held", { id: legId.slice(0, 8) });
  }
  if (data.outcome === "granted" && step === "confirm") {
    heldTransferKey = null;
    heldLegId = null;
    label("handoff-key").textContent = t("key_cleared");
  }
  if (step === "receive" && data.outcome === "refused") {
    heldTransferKey = null;
    heldLegId = null;
  }
  await loadLegs(false);
}

async function requestOverride() {
  if (!navigator.onLine) throw new Error(t("e_need_live_cr"));
  const identity = await get<Identity>("settings", "identity");
  if (!identity) throw new Error(t("e_enrol_first"));
  const legId = input("leg").value.trim();
  if (!validId(legId)) throw new Error(t("e_leg_invalid"));
  const seamIdTyped = input("seam").value.trim();
  if (!seamIdTyped) throw new Error(t("e_need_seam"));
  const photo = input("photo").files?.[0];
  if (!photo) throw new Error(t("e_need_photo_damaged"));
  const attemptedSeconds = Number(input("attempt-seconds").value);
  if (!Number.isInteger(attemptedSeconds) || attemptedSeconds < 1 || attemptedSeconds > 3600) throw new Error(t("e_need_seconds"));
  const photoSha256 = await photoHash(photo);
  const localId = `override-${crypto.randomUUID()}`;
  await put("photos", { file: photo, sha256: photoSha256, eventId: localId, storedAt: new Date().toISOString() }, localId);
  const response = await signedPost(`/legs/${legId}/override`, {
    personId: identity.personId, seamIdTyped, serialTyped: input("serial").value.trim() || undefined,
    attemptedSeconds, whichCodes: input("codes").value, photoSha256,
  });
  const data = await response.json() as { overrideId?: string; error?: string };
  if (!response.ok || !data.overrideId) throw new Error(data.error ?? t("e_override", { status: response.status }));
  // Each of the two operators has to see the packet on a call from this phone
  // before they can approve, so the way to that call is offered here.
  const call = document.createElement("a");
  call.href = `/field/call.html?override=${encodeURIComponent(data.overrideId)}`;
  call.textContent = t("open_call");
  call.style.color = "inherit";
  label("override-status").replaceChildren(
    t("override_sent", { id: data.overrideId }),
    call,
  );
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
  if (!identity || !key) throw new Error(t("e_enrol_first"));
  const packageId = input("package").value.trim();
  if (!validId(packageId)) throw new Error(t("e_package_invalid"));
  const photo = input("photo").files?.[0];
  if (!photo) throw new Error(t("e_need_photo_seal"));
  const digest = await photoHash(photo);
  let raw = input("raw").value.trim();
  const qr = input("qr").files?.[0];
  if (qr) raw = await decodeQr(qr) || raw;
  if (!raw || raw.length > 256) throw new Error(t("e_need_identifier"));
  const id = crypto.randomUUID();
  const deviceSeq = await reserveDeviceSeq(identity.deviceId);
  const body = { v: 1, id, examId: identity.examId, centreId: identity.centreId, packageId,
    occurredAt: new Date().toISOString(), actorDeviceId: identity.deviceId, actorPersonId: identity.personId,
    deviceSeq,
    kind: "SCAN_OBSERVED", payload: { scanType: "qr", rawIdentifier: raw, photoSha256: digest } };
  const signature = await crypto.subtle.sign("Ed25519", key, Uint8Array.from(canonicalBytes(body)));
  await put("photos", { file: photo, sha256: digest, eventId: id, storedAt: new Date().toISOString() }, id);
  // TODO(claim-24): Signed records queue in IndexedDB and retry on reconnect,
  // but this offline/upload path has not been exercised on a real phone.
  await put("queue", { id, signed: { body, deviceSig: hex(signature) } } satisfies Queued);
  label("photo-status").textContent = t("photo_kept", { hash: digest });
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
    catch { say(t("net_down")); break; }
    if (response.status === 200 || response.status === 201) {
      await remove("queue", item.id);
      sent += 1;
      say(t("accepted", { n: sent }));
      continue;
    }
    // 422 is the ledger saying the event cannot be authenticated; 401 is the
    // gateway saying the same thing before the ledger saw it (the device is
    // unknown or revoked, or the signature does not verify). Neither will
    // change on a retry, so the record is kept, marked, and the queue moves on.
    if (response.status === 422 || response.status === 401) {
      const detail = await response.text();
      await put("queue", { ...item, error: t(response.status === 422 ? "rejected_by_ledger" : "rejected_by_gateway", { detail: detail.slice(0, 200) }) });
      continue;
    }
    if (response.status === 429) {
      say(t("limited", { s: response.headers.get("retry-after") ?? t("a_few") }));
      break;
    }
    say(t("server_status", { status: response.status }));
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
// A code shown by the control room opens this page with the ids for one
// person on one packet's route after the `#`. They are put in the boxes and
// taken out of the address; nothing is enrolled or sent because of them.
function fillFromAddress(): void {
  if (!window.location.hash) return;
  const given = new URLSearchParams(window.location.hash.slice(1));
  for (const [param, id] of [["exam", "exam"], ["centre", "centre"], ["person", "person"], ["package", "package"]] as const) {
    const value = given.get(param);
    if (value && validId(value)) input(id).value = value;
  }
  history.replaceState(null, "", window.location.pathname);
}
fillFromAddress();
window.addEventListener("hashchange", fillFromAddress);
void refresh();
if (navigator.serviceWorker) void navigator.serviceWorker.register("/field/sw.js");
