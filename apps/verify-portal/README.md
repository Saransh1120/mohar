# Public verification

The public page is implemented at `/verify` in `apps/control-room/src/pages/PublicVerify.tsx`.
It needs an event UUID and requests `GET /verify/inclusion/:eventId` through the
same `/api` proxy as the control room. The browser checks the chain-hash leaf and
Merkle inclusion proof. A root obtained separately can be pasted for comparison.

For a notarised day, the page offers the RFC 3161 response as a `.tsr` download.
The browser does not validate its certificate chain; use an independent RFC 3161
verifier with the downloaded response and published Merkle root. Without an
independently trusted root or timestamp, this page only proves consistency with
the root returned by the same server.
