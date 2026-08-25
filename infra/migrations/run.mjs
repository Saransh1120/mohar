#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Applies every `NNN_*.sql` in this directory in filename order, inside a
 * transaction, tracking what has already run in `public.schema_migrations`.
 *
 * Run this as the MIGRATOR role (the schema owner), never as `mohar_app`.
 * `mohar_app` deliberately lacks the privileges to create or alter the ledger —
 * that is the append-only guarantee, and a migration running as the app role
 * would either fail or, worse, mean the app role has more power than it should.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "Set MIGRATE_DATABASE_URL (preferred) or DATABASE_URL.\n" +
      "Example: postgres://mohar_migrator:dev_only_password@localhost:5432/mohar",
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  create table if not exists public.schema_migrations (
    filename    text primary key,
    sha256      text not null,
    applied_at  timestamptz not null default now()
  )
`);

const files = (await readdir(here)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();

const { rows: applied } = await client.query(
  "select filename, sha256 from public.schema_migrations",
);
const appliedBy = new Map(applied.map((r) => [r.filename, r.sha256]));

const { createHash } = await import("node:crypto");
let ran = 0;

for (const file of files) {
  const sql = await readFile(join(here, file), "utf8");
  const sha = createHash("sha256").update(sql).digest("hex");
  const previous = appliedBy.get(file);

  if (previous) {
    // A migration whose contents changed after being applied is a real problem:
    // some databases have the old version and some the new, and nothing will say
    // so later. Fail loudly rather than skipping it quietly.
    if (previous !== sha) {
      console.error(
        `\n${file} has been modified since it was applied.\n` +
          `  applied: ${previous}\n  on disk: ${sha}\n` +
          "Write a new migration instead of editing an applied one.",
      );
      await client.end();
      process.exit(1);
    }
    console.log(`  skip  ${file}`);
    continue;
  }

  process.stdout.write(`  apply ${file} ... `);
  try {
    // Each file manages its own begin/commit (001_init.sql does), so we do not
    // wrap it again — nested transactions would swallow the file's own control.
    await client.query(sql);
    await client.query(
      "insert into public.schema_migrations (filename, sha256) values ($1, $2)",
      [file, sha],
    );
    console.log("ok");
    ran++;
  } catch (err) {
    console.log("FAILED");
    console.error(`\n${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\n${ran} migration(s) applied, ${files.length - ran} already current.`);
await client.end();
