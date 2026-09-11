-- 005 · the seam seal commitment
--
-- A QR code printed across the package's opening flap carries a random 32-byte
-- token. Only its commitment is stored here; the token itself lives on the label
-- and nowhere else, so this column reveals nothing if the database is read.
--
-- Nullable, and it stays nullable. Packages sealed before the seam label existed
-- have no commitment, and the access engine reports the seam check as not
-- evaluated for them rather than failing them — the same treatment the hardware
-- checks get when no sensor is fitted. Backfilling a value would be inventing a
-- seal that was never applied.
--
-- Written to run as mohar_migrator. It adds no grant to mohar_app, which keeps
-- SELECT and INSERT only; the append-only guarantee is unchanged by this file.

alter table ref.package
  add column seam_commitment char(64);

comment on column ref.package.seam_commitment is
  'sha256(seamToken || packageId) for the flap QR. Null for packages sealed '
  'before the seam label existed; the access engine reports those as not evaluated.';

-- The commitment must be a lowercase sha256 digest or absent. char(64) already
-- fixes the width; this fixes the alphabet, so a mis-cased or truncated value
-- cannot be stored and then silently fail every comparison at ceremony time.
alter table ref.package
  add constraint package_seam_commitment_hex
  check (seam_commitment is null or seam_commitment ~ '^[0-9a-f]{64}$');
