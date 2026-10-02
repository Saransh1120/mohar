import { useEffect, useRef } from "react";
import { parseSeamQr } from "@mohar/crypto-core";

/** The two secret shares stay in the URL fragment and never travel to the API. */
export default function SeamLanding() {
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    let scan: ReturnType<typeof parseSeamQr> | null = null;
    try {
      scan = parseSeamQr(window.location.href);
    } catch {
      // A malformed or hand-typed URL gets the same public page.
    }
    // Remove the share from the address bar before doing any network work.
    history.replaceState(null, "", "/s");
    if (!scan) return;
    void fetch("/api/public/seam-scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seamId: scan.seamId, whichCodes: scan.which }),
    }).catch(() => {
      // The visitor never learns whether this label exists or whether the
      // ledger is reachable; the custody team sees recorded scans when online.
    });
  }, []);

  return <main style={{ maxWidth: 540, margin: "12vh auto", padding: 28, fontFamily: "system-ui", lineHeight: 1.6 }}>
    <h1>Mohar</h1>
    <p>This examination packet is under custody. If you found it outside its authorised route, contact the exam authority.</p>
    <p>The QR codes on the seal are for authorised custody checks.</p>
  </main>;
}
