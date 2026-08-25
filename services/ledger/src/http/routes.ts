import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { verifyChain, type ChainLink } from "@mohar/crypto-core";
import { bytesToHex } from "@noble/hashes/utils";
import { appendEvent } from "../append.js";
import { buildAnchor, proveInclusion } from "../anchor.js";
import { withTransaction } from "../db.js";

export function registerRoutes(app: FastifyInstance, pool: Pool): void {
  /**
   * Append one signed event.
   *
   * Status codes carry meaning for an offline client draining a queue:
   *   201 appended      — new event, now in the chain
   *   200 duplicate     — already had it; the client can drop it from the queue
   *   422 rejected      — could not authenticate; the client must NOT retry
   *                       blindly, because retrying an unauthenticatable event
   *                       forever is how a queue wedges
   */
  app.post("/events", async (req, reply) => {
    const outcome = await withTransaction(pool, (tx) => appendEvent(tx, req.body));

    switch (outcome.status) {
      case "appended":
        if (outcome.flags.length > 0) {
          req.log.warn(
            { eventId: outcome.record.body.id, flags: outcome.flags },
            "event accepted with policy flags",
          );
        }
        return reply.code(201).send({
          status: "appended",
          seq: outcome.record.seq,
          hash: outcome.record.hash,
          prevHash: outcome.record.prevHash,
          bodyHash: outcome.record.bodyHash,
          receivedAt: outcome.record.receivedAt,
          clockSkewMs: outcome.record.clockSkewMs,
          flags: outcome.flags,
        });

      case "duplicate":
        return reply.code(200).send({
          status: "duplicate",
          seq: outcome.record.seq,
          hash: outcome.record.hash,
        });

      case "rejected":
        req.log.warn({ rejection: outcome.rejection }, "event rejected");
        return reply.code(422).send({ status: "rejected", ...outcome.rejection });
    }
  });

  /** Bulk drain for a field app coming back online. Each event is independent. */
  app.post("/events/batch", async (req, reply) => {
    const items = Array.isArray(req.body) ? req.body : [];
    if (items.length === 0 || items.length > 500) {
      return reply.code(400).send({ error: "send between 1 and 500 events" });
    }

    // Sequential, not concurrent: appends serialise on the chain-tail advisory
    // lock anyway, and doing them in parallel would just create lock contention
    // that looks like a stall to a phone on a weak connection.
    const results = [];
    for (const item of items) {
      const outcome = await withTransaction(pool, (tx) => appendEvent(tx, item));
      results.push(
        outcome.status === "rejected"
          ? { status: "rejected", ...outcome.rejection }
          : { status: outcome.status, seq: outcome.record.seq, hash: outcome.record.hash },
      );
    }
    return reply.code(207).send({ results });
  });

  /** Read a slice of the chain. */
  app.get<{ Querystring: { examId?: string; afterSeq?: string; limit?: string } }>(
    "/events",
    async (req, reply) => {
      const limit = Math.min(Number(req.query.limit ?? 100), 1000);
      const afterSeq = req.query.afterSeq ?? "0";
      const { rows } = await pool.query(
        `select seq, id, kind, body, occurred_at, received_at, clock_skew_ms,
                encode(body_hash,'hex') as body_hash,
                encode(prev_hash,'hex') as prev_hash,
                encode(hash,'hex')      as hash
           from led.event
          where seq > $1
            and ($2::uuid is null or exam_id = $2::uuid)
          order by seq asc
          limit $3`,
        [afterSeq, req.query.examId ?? null, limit],
      );
      return reply.send({ events: rows });
    },
  );

  /**
   * The same slice of chain, pushed instead of polled.
   *
   * Server-Sent Events rather than a WebSocket, and the choice is not
   * incidental. Nothing here ever travels browser-to-server: the client asks
   * once and then only listens, which is exactly the half of a WebSocket that
   * would be used. What SSE adds for free is the half that matters in a room
   * with a phone hotspot — the browser reconnects on its own when the link
   * drops, and `Last-Event-ID` lets it say where it got to, so a reconnect
   * resumes rather than restarts. A WebSocket would need all of that written by
   * hand, and written correctly, to end up in the same place.
   *
   * The cursor is the chain sequence, so this is the polling contract with the
   * waiting moved to the server. A client that loses the stream entirely can
   * fall back to `GET /events?afterSeq=` and miss nothing.
   */
  app.get<{ Querystring: { examId?: string; afterSeq?: string } }>(
    "/events/stream",
    async (req, reply) => {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Without this an intermediary may hold the stream to fill a buffer,
        // which turns a live feed into a delayed one for no visible reason.
        "x-accel-buffering": "no",
        "access-control-allow-origin": "*",
      });

      // A reconnecting browser sends back the id of the last event it saw, and
      // that is more trustworthy than the query string it was first opened
      // with — it reflects what actually arrived rather than what was asked for.
      const resumeFrom = (req.headers["last-event-id"] as string | undefined) ?? undefined;
      let cursor = resumeFrom ?? req.query.afterSeq ?? "0";
      const examId = req.query.examId ?? null;

      let closed = false;
      const stop = () => {
        closed = true;
      };
      req.raw.on("close", stop);
      req.raw.on("error", stop);

      const send = (event: string, data: unknown, id?: string) => {
        if (closed) return;
        if (id) reply.raw.write(`id: ${id}\n`);
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Tell the client where the stream begins. Without this it cannot
      // distinguish "connected, nothing new" from "not connected yet".
      send("open", { cursor });

      try {
        while (!closed) {
          const { rows } = await pool.query(
            `select seq, id, kind, body, occurred_at, received_at, clock_skew_ms,
                    encode(body_hash,'hex') as body_hash,
                    encode(prev_hash,'hex') as prev_hash,
                    encode(hash,'hex')      as hash
               from led.event
              where seq > $1
                and ($2::uuid is null or exam_id = $2::uuid)
              order by seq asc
              limit 200`,
            [cursor, examId],
          );

          for (const row of rows) {
            cursor = String(row.seq);
            send("event", row, cursor);
          }

          // A comment line is a heartbeat: it keeps proxies from reaping an idle
          // connection, and costs one line rather than a fabricated event that
          // a client would have to learn to ignore.
          if (rows.length === 0) reply.raw.write(": keep-alive\n\n");

          await new Promise((r) => setTimeout(r, rows.length > 0 ? 100 : 1500));
        }
      } catch (err) {
        app.log.error({ err }, "event stream failed");
      } finally {
        req.raw.off("close", stop);
        req.raw.off("error", stop);
        reply.raw.end();
      }
    },
  );

  /**
   * Recompute the chain over a range and report every break.
   *
   * Deliberately returns all breaks rather than the first: during an
   * investigation the shape of the damage is the finding. One isolated break
   * suggests corruption; a run of them from a single point onward suggests a
   * rewrite attempt.
   */
  app.get<{ Querystring: { fromSeq?: string; toSeq?: string } }>(
    "/verify/chain",
    async (req, reply) => {
      const fromSeq = req.query.fromSeq ?? "0";
      const { rows } = await pool.query<{
        seq: string;
        body_hash: string;
        prev_hash: string;
        hash: string;
      }>(
        `select seq,
                encode(body_hash,'hex') as body_hash,
                encode(prev_hash,'hex') as prev_hash,
                encode(hash,'hex')      as hash
           from led.event
          where seq > $1 and ($2::bigint is null or seq <= $2::bigint)
          order by seq asc`,
        [fromSeq, req.query.toSeq ?? null],
      );

      if (rows.length === 0) {
        return reply.send({ checked: 0, intact: true, breaks: [] });
      }

      // Start from the declared prev_hash of the first row in the window, so a
      // partial-range check does not report a spurious break at its own edge.
      const startingFrom = Uint8Array.from(
        Buffer.from(rows[0]!.prev_hash, "hex"),
      );
      const links: ChainLink[] = rows.map((row) => ({
        seq: row.seq,
        bodyHash: row.body_hash,
        prevHash: row.prev_hash,
        hash: row.hash,
      }));
      const breaks = verifyChain(links, startingFrom);

      return reply.send({
        checked: rows.length,
        fromSeq: rows[0]!.seq,
        toSeq: rows[rows.length - 1]!.seq,
        intact: breaks.length === 0,
        breaks,
      });
    },
  );

  /** Inclusion proof for one event, for the public verify portal. */
  app.get<{ Params: { eventId: string } }>(
    "/verify/inclusion/:eventId",
    async (req, reply) => {
      const proof = await proveInclusion(pool, req.params.eventId);
      if (!proof) {
        return reply
          .code(404)
          .send({ error: "unknown event, or its day has not been anchored yet" });
      }
      return reply.send(proof);
    },
  );

  /** Published anchors. Public, unauthenticated — this is the transparency surface. */
  app.get("/anchors", async (_req, reply) => {
    const { rows } = await pool.query(
      `select to_char(day,'YYYY-MM-DD') as day,
              encode(merkle_root,'hex') as merkle_root,
              first_seq, last_seq, tree_size,
              (tsa_token is not null) as notarised,
              published_at
         from led.anchor
        order by day desc
        limit 400`,
    );
    return reply.send({ anchors: rows });
  });

  /** Trigger anchoring for a day. Idempotent; safe to re-run. */
  app.post<{ Body: { day?: string } }>("/anchors/build", async (req, reply) => {
    const day =
      req.body?.day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const result = await buildAnchor(pool, day);
    if (!result) return reply.code(200).send({ day, treeSize: 0, note: "no events" });
    return reply.code(201).send(result);
  });

  app.get("/health", async (_req, reply) => {
    const { rows } = await pool.query<{ seq: string; hash: Buffer }>(
      "select seq, hash from led.event order by seq desc limit 1",
    );
    const tail = rows[0];
    return reply.send({
      ok: true,
      chainTip: tail
        ? { seq: tail.seq, hash: bytesToHex(new Uint8Array(tail.hash)) }
        : null,
    });
  });
}
