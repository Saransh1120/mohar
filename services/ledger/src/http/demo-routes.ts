import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { generateSeamLabel } from "@mohar/crypto-core";
import { withTransaction } from "../db.js";

/**
 * ── A packet to hand off, for the Transfers page ─────────────────────────────
 *
 *   POST /demo/journey      a sealed packet, its label, three people and two legs
 *   POST /demo/strongroom   a strong room, its door device and three people (below)
 *   POST /demo/opening      a packet at its centre, due to open in minutes (below)
 *                        body (optional): { dueInMinutes }  leg 1 expected by then,
 *                        leg 2 by twice that; default 30
 *
 * There is no sealing service yet, so nothing else can put a seam label on a
 * packet. This writes the reference data a press would have written — packet,
 * label commitment, the people on the route, the planned legs — and nothing
 * more. It does not touch led.*: every dispatch, receive and confirm after this
 * goes through the hand-off engine and is recorded by it like any other.
 *
 * The response carries both halves of the label, because a printed label is
 * exactly those two QR codes and the page stands in for the phone that scans
 * them. Only the commitment is stored; the secret leaves in this response and
 * is not kept anywhere on the server.
 *
 * `dueInMinutes` sets how soon the legs are expected to close. A short one is
 * how the Delayed Transfer Alert is shown without waiting half an hour: the
 * packet is planned with a tight deadline and then simply not handed over, and
 * the watchdog decides on its own that the leg is late. Nothing here raises an
 * alert or marks a leg late — only the expected time is chosen.
 *
 * Set DISABLE_DEMO_ROUTES=1 to leave this unregistered.
 */

const PEOPLE = [
  { key: "press", name: "A. Sharma", role: "press_operator" },
  { key: "courier", name: "B. Meena", role: "courier" },
  { key: "custodian", name: "C. Rathore", role: "custodian" },
] as const;

const JourneyBody = z.object({
  dueInMinutes: z.number().int().min(1).max(60).optional(),
});

const LAT = 26.9124;
const LON = 75.7873;

export function registerDemoRoutes(app: FastifyInstance, pool: Pool): void {
  if (process.env["DISABLE_DEMO_ROUTES"] === "1") return;

  app.post("/demo/journey", async (req, reply) => {
    const parsed = JourneyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "dueInMinutes must be a whole number from 1 to 60" });
    }
    const dueMs = (parsed.data.dueInMinutes ?? 30) * 60_000;
    const label = generateSeamLabel();
    const tag = randomBytes(2).toString("hex").toUpperCase();
    const serial = `PKT-JPR-${String(1000 + Math.floor(Math.random() * 9000))}`;
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

    const out = await withTransaction(pool, async (tx) => {
      const { rows: auth } = await tx.query<{ id: string }>(
        `insert into ref.authority (name) values ('Hand-off demonstration')
         on conflict (name) do update set name = excluded.name
         returning id`,
      );
      const { rows: exam } = await tx.query<{ id: string }>(
        `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
         values ($1, $2, 'escorted', now() + interval '1 day', 1, 4)
         returning id`,
        [auth[0]!.id, `Hand-off run ${tag}`],
      );
      const { rows: centre } = await tx.query<{ id: string }>(
        `insert into ref.centre (exam_id, code, lat, lon, capacity)
         values ($1, $2, $3, $4, 300)
         returning id`,
        [exam[0]!.id, `JPR-HOP-${tag}`, LAT, LON],
      );
      const { rows: pkg } = await tx.query<{ id: string }>(
        `insert into ref.package (exam_id, centre_id, seal_serial, copies)
         values ($1, $2, $3, 300)
         returning id`,
        [exam[0]!.id, centre[0]!.id, serial],
      );
      const packageId = pkg[0]!.id;

      await tx.query(
        `insert into ref.seal_label (package_id, seam_id, commitment_hex, labels_per_packet)
         values ($1, $2, $3, 2)`,
        [packageId, label.seamId, label.commitment],
      );

      const people: Record<string, { id: string; name: string; role: string }> = {};
      for (const p of PEOPLE) {
        const { rows } = await tx.query<{ id: string }>(
          `insert into ref.person (display_name, role, govt_id_hash)
           values ($1, $2, $3) returning id`,
          [p.name, p.role, randomBytes(32)],
        );
        people[p.key] = { id: rows[0]!.id, name: p.name, role: p.role };
      }

      // A courier's handheld: unbound to any centre, since it travels the route.
      const { rows: device } = await tx.query<{ id: string }>(
        `insert into ref.device (kind, pubkey) values ('field', $1) returning id`,
        [randomBytes(32)],
      );

      const legs: string[] = [];
      const plan = [
        {
          no: 1, from: "press_operator", to: "courier",
          fromPlace: "Government Press, Jaipur", toPlace: "Route vehicle",
          expectedBy: iso(dueMs),
        },
        {
          no: 2, from: "courier", to: "custodian",
          fromPlace: "Route vehicle", toPlace: "District strong room, Jaipur",
          expectedBy: iso(2 * dueMs),
        },
      ];
      for (const l of plan) {
        const { rows } = await tx.query<{ id: string }>(
          `insert into ref.route_leg
             (package_id, leg_no, from_role, to_role, from_place, to_place,
              window_start, window_end, expected_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id`,
          [packageId, l.no, l.from, l.to, l.fromPlace, l.toPlace,
            iso(-10 * 60_000), iso(3 * 3600_000), l.expectedBy],
        );
        legs.push(rows[0]!.id);
      }

      return { packageId, people, deviceId: device[0]!.id, legs };
    });

    return reply.code(201).send({
      packageId: out.packageId,
      serial,
      deviceId: out.deviceId,
      people: out.people,
      legIds: out.legs,
      label: {
        seamId: label.seamId,
        shareAHex: Buffer.from(label.shareA).toString("hex"),
        shareBHex: Buffer.from(label.shareB).toString("hex"),
      },
    });
  });

  /**
   * A strong room with a door to try.
   *
   *   POST /demo/strongroom
   *
   * A room, the device at its door, and three people with a finger each
   * registered on that device: a custodian and a district officer, who may
   * enter, and a courier, who may not. Reference data only. Every entry and
   * exit after this is decided and recorded by the door engine.
   *
   * No room monitor is attached, because a monitor's footfall comes from events
   * it signs and nothing here can sign as one. The footfall check on these
   * visits therefore reports that it was not evaluated.
   */
  app.post("/demo/strongroom", async (_req, reply) => {
    const tag = randomBytes(2).toString("hex").toUpperCase();
    const out = await withTransaction(pool, async (tx) => {
      const { rows: room } = await tx.query<{ id: string }>(
        `insert into ref.strong_room (name, place) values ($1, $2) returning id`,
        [`Strong room ${tag}`, "District treasury, Jaipur"],
      );
      const { rows: device } = await tx.query<{ id: string }>(
        `insert into ref.device (kind, pubkey) values ('centre_pc', $1) returning id`,
        [randomBytes(32)],
      );
      const people = [];
      const cast = [
        { name: "C. Rathore", role: "custodian", slot: 1 },
        { name: "D. Singh", role: "district_officer", slot: 11 },
        { name: "B. Meena", role: "courier", slot: 21 },
      ];
      for (const p of cast) {
        const { rows } = await tx.query<{ id: string }>(
          `insert into ref.person (display_name, role, govt_id_hash)
           values ($1, $2, $3) returning id`,
          [p.name, p.role, randomBytes(32)],
        );
        await tx.query(
          `insert into ref.fingerprint_enrolment (device_id, template_slot, person_id, role, finger_label)
           values ($1, $2, $3, $4, 'right index')`,
          [device[0]!.id, p.slot, rows[0]!.id, p.role],
        );
        people.push({ id: rows[0]!.id, name: p.name, role: p.role, slot: p.slot });
      }
      return { roomId: room[0]!.id, roomName: `Strong room ${tag}`, deviceId: device[0]!.id, people };
    });
    return reply.code(201).send(out);
  });

  /**
   * A packet at its centre, due to open soon, with three officials to open it.
   *
   *   POST /demo/opening   body: { stationDeviceId, startsInMinutes? }
   *
   * The exam starts in `startsInMinutes` (17 by default, 16 to 120), so the
   * packet is due to open fifteen minutes before that: two minutes from now by
   * default. That is chosen so the time lock can be watched opening without a
   * half-hour wait. Nothing is shortened: the control room's part is locked to
   * the real drand round for that minute and cannot be read before it.
   *
   * This writes the packet, its seam label, the three officials with a finger
   * each registered on the given station, and an unlocked duty roster. It does
   * not lock the roster and issues no key: that is done on the Rosters page,
   * through the same route any roster is locked by.
   */
  const OpeningBody = z.object({
    stationDeviceId: z.string().uuid(),
    startsInMinutes: z.number().int().min(16).max(120).optional(),
  });

  app.post("/demo/opening", async (req, reply) => {
    const parsed = OpeningBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "stationDeviceId is required; startsInMinutes, if given, is 16 to 120",
      });
    }
    const startsIn = parsed.data.startsInMinutes ?? 17;
    const label = generateSeamLabel();
    const tag = randomBytes(2).toString("hex").toUpperCase();
    const serial = `PKT-JPR-${String(1000 + Math.floor(Math.random() * 9000))}`;

    const out = await withTransaction(pool, async (tx) => {
      const { rows: station } = await tx.query<{ id: string; revoked_at: Date | null }>(
        "select id, revoked_at from ref.device where id = $1::uuid",
        [parsed.data.stationDeviceId],
      );
      if (!station[0] || station[0].revoked_at) return null;

      // Three free slots on this station's reader. A slot already registered
      // belongs to somebody, and the register does not reuse one.
      const { rows: used } = await tx.query<{ template_slot: number }>(
        `select template_slot from ref.fingerprint_enrolment
          where device_id = $1::uuid and revoked_at is null`,
        [station[0].id],
      );
      const taken = new Set(used.map((u) => u.template_slot));
      const free: number[] = [];
      for (let s = 1; s <= 127 && free.length < 3; s += 1) if (!taken.has(s)) free.push(s);
      if (free.length < 3) return "full" as const;

      const { rows: auth } = await tx.query<{ id: string }>(
        `insert into ref.authority (name) values ('Opening demonstration')
         on conflict (name) do update set name = excluded.name
         returning id`,
      );
      const { rows: exam } = await tx.query<{ id: string; starts_at: Date }>(
        `insert into ref.exam (authority_id, name, mode, starts_at, drand_round, sides_per_copy)
         values ($1, $2, 'escorted', now() + make_interval(mins => $3), 1, 4)
         returning id, starts_at`,
        [auth[0]!.id, `Opening run ${tag}`, startsIn],
      );
      const { rows: centre } = await tx.query<{ id: string }>(
        `insert into ref.centre (exam_id, code, lat, lon, capacity)
         values ($1, $2, $3, $4, 300) returning id`,
        [exam[0]!.id, `JPR-OPN-${tag}`, LAT, LON],
      );
      const { rows: pkg } = await tx.query<{ id: string }>(
        `insert into ref.package (exam_id, centre_id, seal_serial, copies, state)
         values ($1, $2, $3, 300, 'at_centre') returning id`,
        [exam[0]!.id, centre[0]!.id, serial],
      );
      await tx.query(
        `insert into ref.seal_label (package_id, seam_id, commitment_hex, labels_per_packet)
         values ($1, $2, $3, 1)`,
        [pkg[0]!.id, label.seamId, label.commitment],
      );

      const officials = [];
      const cast = [
        { name: "S. Verma", role: "superintendent" },
        { name: "O. Khan", role: "observer" },
        { name: "P. Yadav", role: "police_escort" },
      ];
      for (const [i, p] of cast.entries()) {
        const { rows } = await tx.query<{ id: string }>(
          `insert into ref.person (display_name, role, govt_id_hash)
           values ($1, $2, $3) returning id`,
          [p.name, p.role, randomBytes(32)],
        );
        await tx.query(
          `insert into ref.fingerprint_enrolment (device_id, template_slot, person_id, role, finger_label)
           values ($1, $2, $3, $4, 'right index')`,
          [station[0].id, free[i], rows[0]!.id, p.role],
        );
        await tx.query(
          `insert into ref.duty_roster (centre_id, exam_session, role, person_id)
           values ($1, $2, $3, $4)`,
          [centre[0]!.id, exam[0]!.id, p.role, rows[0]!.id],
        );
        officials.push({ id: rows[0]!.id, name: p.name, role: p.role, slot: free[i]! });
      }

      return {
        examId: exam[0]!.id,
        examStartsAt: exam[0]!.starts_at,
        centreId: centre[0]!.id,
        centreCode: `JPR-OPN-${tag}`,
        packageId: pkg[0]!.id,
        officials,
      };
    });

    if (out === null) return reply.code(404).send({ error: "no such station device, or it is revoked" });
    if (out === "full") {
      return reply.code(409).send({ error: "this station's reader has fewer than three free slots" });
    }
    return reply.code(201).send({
      ...out,
      serial,
      stationDeviceId: parsed.data.stationDeviceId,
      label: {
        seamId: label.seamId,
        shareAHex: Buffer.from(label.shareA).toString("hex"),
        shareBHex: Buffer.from(label.shareB).toString("hex"),
      },
    });
  });
}
