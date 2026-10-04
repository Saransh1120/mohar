import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { alertNotice, emailChannel, type AlertForNotice } from "./notify.js";

/**
 * ── The email channel, against a mail server that is really there ────────────
 *
 * notify.test.ts checks that the channel is built from the environment. It
 * never sent anything. Here the channel speaks SMTP to a small server on
 * loopback that records what it is given, so what is checked is the mail that
 * would arrive: who from, who to, the subject, the text, and that a server
 * refusing it is reported as a failure and not swallowed.
 *
 * This is not Gmail. It shows the channel sends a correct message over SMTP
 * with a username and password taken from the URL. Whether Gmail accepts this
 * deployment's app password, and where the mail lands, has to be seen once on
 * the real thing; RUNNING.md says that has not been done.
 */

interface Received {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

interface Sink {
  port: number;
  mail: Received[];
  close: () => Promise<void>;
}

/** Enough of SMTP to accept one message per connection, or to refuse it. */
function smtpSink(options: { requireAuth?: string; refuse?: boolean } = {}): Promise<Sink> {
  const mail: Received[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let authed: string | null = null;
    const current: Received = { from: "", to: [], data: "", auth: null };
    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 sink ready");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          if (options.refuse) {
            say("550 mailbox unavailable");
          } else {
            mail.push({ ...current, to: [...current.to], auth: authed });
            say("250 accepted");
          }
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") {
          socket.write("250-sink\r\n");
          if (options.requireAuth) socket.write("250-AUTH PLAIN\r\n");
          say("250 OK");
        } else if (verb === "AUTH") {
          // AUTH PLAIN <base64 of \0user\0password>
          const decoded = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
          const [, user, password] = decoded.split("\0");
          if (`${user}:${password}` === options.requireAuth) {
            authed = user ?? null;
            say("235 authenticated");
          } else {
            say("535 credentials rejected");
          }
        } else if (verb === "MAIL") {
          if (options.requireAuth && !authed) say("530 authentication required");
          else {
            current.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
            say("250 OK");
          }
        } else if (verb === "RCPT") {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          say("250 OK");
        } else if (verb === "DATA") {
          inData = true;
          say("354 go ahead");
        } else if (verb === "QUIT") {
          say("221 bye");
          socket.end();
        } else {
          say("250 OK");
        }
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        mail,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const ALERT: AlertForNotice = {
  id: "dddddddd-0000-4000-8000-000000000001",
  kind: "LEG_OVERDUE",
  raisedAt: new Date("2026-09-27T09:00:12.000Z"),
  consequence: "B. Meena (courier) dispatched this packet and nobody has accepted it.",
  requiresDecision: true,
  packetSerial: "PKT-JPR-0091",
  centreCode: "JPR-014",
  legNo: 2,
  fromPlace: "Route vehicle",
  toPlace: "District strong room, Jaipur",
};

test("an alert sent by email arrives with its sender, recipient, subject and text", async () => {
  const sink = await smtpSink();
  try {
    const notice = alertNotice(ALERT);
    await emailChannel(`smtp://127.0.0.1:${sink.port}`, "mohar@board.example", "control-room@board.example").send(notice);
    assert.equal(sink.mail.length, 1);
    const m = sink.mail[0]!;
    assert.equal(m.from, "mohar@board.example");
    assert.deepEqual(m.to, ["control-room@board.example"]);
    assert.match(m.data, new RegExp(`^Subject: ${notice.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
    // The body may be wrapped or encoded in transit; the packet's serial and
    // the leg survive either.
    assert.match(m.data, /PKT-JPR-0091/);
    assert.match(m.data.replace(/=\r\n/g, ""), /nobody has accepted it/);
    assert.doesNotMatch(m.data, /critical|severity|high priority/i);
  } finally {
    await sink.close();
  }
});

test("a username and password in the SMTP URL are presented to a server that asks for them", async () => {
  const sink = await smtpSink({ requireAuth: "alerts@board.example:test-app-password" });
  try {
    const url = `smtp://${encodeURIComponent("alerts@board.example")}:test-app-password@127.0.0.1:${sink.port}`;
    await emailChannel(url, "alerts@board.example", "control-room@board.example").send(alertNotice(ALERT));
    assert.equal(sink.mail.length, 1);
    assert.equal(sink.mail[0]!.auth, "alerts@board.example");
  } finally {
    await sink.close();
  }
});

test("a wrong password is a failed send, not a silent one", async () => {
  const sink = await smtpSink({ requireAuth: "alerts@board.example:the-right-one" });
  try {
    const url = `smtp://${encodeURIComponent("alerts@board.example")}:the-wrong-one@127.0.0.1:${sink.port}`;
    await assert.rejects(
      emailChannel(url, "alerts@board.example", "control-room@board.example").send(alertNotice(ALERT)),
    );
    assert.equal(sink.mail.length, 0);
  } finally {
    await sink.close();
  }
});

test("a server that refuses the message makes the send fail, so the notifier records it and retries", async () => {
  const sink = await smtpSink({ refuse: true });
  try {
    await assert.rejects(
      emailChannel(`smtp://127.0.0.1:${sink.port}`, "mohar@board.example", "control-room@board.example").send(alertNotice(ALERT)),
    );
    assert.equal(sink.mail.length, 0);
  } finally {
    await sink.close();
  }
});

test("a mail server that is not there is a failed send within the timeout", async () => {
  const sink = await smtpSink();
  const port = sink.port;
  await sink.close();
  await assert.rejects(
    emailChannel(`smtp://127.0.0.1:${port}`, "mohar@board.example", "control-room@board.example").send(alertNotice(ALERT)),
  );
});
