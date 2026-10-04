import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import { encodeSeamQr } from "@mohar/crypto-core";
import type { DemoJourney } from "../lib/api";

/**
 * ── Doing a hand-off from real phones ────────────────────────────────────────
 *
 * The console on this page stands in for the phone at each end. To put real
 * phones there instead, each one has to be enrolled as a person on this
 * packet's route and then has to photograph the packet's label. Both need
 * things that are otherwise typed by hand: four ids for the enrolment, and a
 * label that exists only as numbers in this browser.
 *
 * This shows them as codes to point a phone at. An enrolment code opens the
 * field app with the ids filled in; nothing is enrolled until an operator
 * enters their own password on the phone. The two label codes are the packet's
 * seam label, as the press would have printed it.
 *
 * The ids ride in the part of the address after `#`, which a browser does not
 * send to the server. They are record ids, not secrets. The label's two codes
 * together ARE the seam secret: anyone who photographs both can pass the seam
 * check for this packet, exactly as with a printed label in front of them.
 */

const fromHex = (hex: string) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));

/**
 * Where the field app is served: beside the control room when deployed, and on
 * its own dev server (:5174) when this page is on the control room's (:5173).
 */
function fieldAppBase(): string {
  const { hostname, port, origin } = window.location;
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  return local && port === "5173" ? `http://${hostname}:5174/field/` : `${origin}/field/`;
}

function Code({ text, caption, size = 150 }: { text: string; caption: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void toDataURL(text, { errorCorrectionLevel: "M", margin: 2, width: size * 2 }).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [text, size]);
  return (
    <figure style={{ margin: 0, textAlign: "center", width: size + 16 }}>
      {src ? (
        <img src={src} alt={caption} width={size} height={size} style={{ background: "#fff", padding: 6, borderRadius: 4 }} />
      ) : (
        <div style={{ width: size, height: size }} />
      )}
      <figcaption style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{caption}</figcaption>
    </figure>
  );
}

export function PhonePanel({ journey }: { journey: DemoJourney }) {
  const [open, setOpen] = useState(false);
  if (!journey.examId || !journey.centreId) {
    // A packet made before this panel existed did not keep its exam and centre.
    return (
      <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 10 }}>
        To hand this over from real phones, make a new packet: this one was made before its exam
        and centre were kept in this browser.
      </div>
    );
  }
  const enrolUrl = (personId: string) =>
    `${fieldAppBase()}#${new URLSearchParams({
      exam: journey.examId!,
      centre: journey.centreId!,
      person: personId,
      package: journey.packageId,
    }).toString()}`;

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <button onClick={() => setOpen(!open)}>
        {open ? "Hide the phone codes" : "Hand this over from real phones"}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div className="note" style={{ marginTop: 0 }}>
            <strong>1 · Enrol each phone.</strong> Point a phone's camera at the code for the person
            holding it. The field app opens with the ids filled in; an operator then types their own
            username and password on the phone to enrol it. One phone is one person.
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {Object.values(journey.people).map((p) => (
              <Code key={p.id} text={enrolUrl(p.id)} caption={`${p.name} (${p.role.replace(/_/g, " ")})`} />
            ))}
          </div>

          <div className="note">
            <strong>2 · The packet's label.</strong> In the field app, load the legs, then use{" "}
            <em>QR A image</em> and <em>QR B image</em> to photograph these two, one at a time. Do it
            from inside the field app: opening either with the phone's ordinary camera lands on the
            public page and raises an alert, which is what the label is for. Serial to type at
            receive: <span className="mono">{journey.serial}</span>.
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Code
              size={190}
              caption="Label code A"
              text={encodeSeamQr(window.location.origin, "A", journey.label.seamId, fromHex(journey.label.shareAHex))}
            />
            <Code
              size={190}
              caption="Label code B"
              text={encodeSeamQr(window.location.origin, "B", journey.label.seamId, fromHex(journey.label.shareBHex))}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
            These two codes together are the label's secret. On a real packet they are printed on a
            label that tears when the packet is opened; here they are on a screen, for a rehearsal.
          </div>
        </div>
      )}
    </div>
  );
}
