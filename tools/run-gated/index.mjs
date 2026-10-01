#!/usr/bin/env node
/**
 * Run the ledger behind its gateway, as one command.
 *
 *   DATABASE_URL=postgres://mohar_app:...@localhost:5432/mohar  pnpm start
 *
 * Two processes:
 *
 *   everything outside ──> gateway  (PORT, default 8081, every interface)
 *                             │
 *                             └──> ledger  (LEDGER_PORT, default 8091, loopback only)
 *
 * The gateway takes the port the ledger used to listen on, so nothing that
 * already points at it has to change: the control room's /api proxy, a room
 * monitor's LEDGER_BASE_URL, a hosting platform's PORT. What changes is that
 * the ledger is no longer reachable from another machine at all.
 *
 * Tools that run on this machine and speak to the ledger without signing in
 * (tools/seed, tools/label-print, tools/demo-setup) still can, on loopback:
 *
 *   LEDGER_URL=http://127.0.0.1:8091  node tools/seed/dist/index.js
 *
 * Set GATEWAY_SECRET to close that as well; both processes are given it and the
 * ledger then answers only requests that carry it.
 *
 * If either process stops, the other is stopped and this exits with its code:
 * a gateway with no ledger behind it answers 502 to everything, and a ledger
 * with no gateway in front is not reachable, so neither is worth keeping up.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const publicPort = Number(process.env.PORT ?? 8081);
// 8091, not the next port up: 8082 is where services/access listens.
const ledgerPort = Number(process.env.LEDGER_PORT ?? 8091);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Copy .env.example and set it.");
  process.exit(1);
}
if (publicPort === ledgerPort) {
  console.error(`PORT and LEDGER_PORT are both ${publicPort}. They are two processes.`);
  process.exit(1);
}

const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  // Give them a moment to close their connections, then leave regardless.
  setTimeout(() => process.exit(code), 3000).unref();
}

function start(name, entry, env) {
  const child = spawn(process.execPath, [join(root, entry)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (!stopping) console.error(`${name} stopped (${signal ?? `exit ${code}`}); stopping the other.`);
    stop(code ?? 1);
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit(code ?? 1);
  });
  children.push(child);
  return child;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

start("ledger", "services/ledger/dist/index.js", {
  HOST: "127.0.0.1",
  PORT: String(ledgerPort),
});

// The gateway is started once the ledger answers, so the first request through
// it is not a 502 for a ledger that was still checking its grants.
const ledgerUrl = `http://127.0.0.1:${ledgerPort}`;
const deadline = Date.now() + 30_000;
let up = false;
while (!up && !stopping && Date.now() < deadline) {
  try {
    const res = await fetch(`${ledgerUrl}/ping`, {
      headers: process.env.GATEWAY_SECRET ? { "x-mohar-gateway": process.env.GATEWAY_SECRET } : {},
    });
    up = res.ok;
  } catch {
    /* not listening yet */
  }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) {
  if (!stopping) console.error(`The ledger did not answer on ${ledgerUrl} within 30 s.`);
  stop(1);
} else {
  start("gateway", "services/gateway/dist/index.js", {
    GATEWAY_PORT: String(publicPort),
    LEDGER_URL: ledgerUrl,
  });
}
