# access

Package access policy engine. Evaluates whether a custody action is authorised
and issues a signed decision receipt.

The QR/NFC tag is an identifier, never a key — anyone who photographs it holds a
perfect copy. Scanning opens a session; this service checks Android Keystore
attestation, roster membership, geofence, time window, seal-serial match and
package state, deny-by-default, with a reason code on every refusal.

There is no electronic latch. The decision is advisory physically and binding
evidentially: an operator who proceeds past a denial generates an `OVERRIDE_USED`
event that pages the control room in real time. Denied scans are the highest-value
signal the system produces and are never pruned.

See `docs/05-unlock-protocol.md`.
