# Public verification

The public page is implemented at `/verify` in `apps/control-room/src/pages/PublicVerify.tsx`.
It needs an event UUID and requests `GET /verify/inclusion/:eventId` through the
same `/api` proxy as the control room. That route is one of the few the gateway
serves without a session.

The browser works out three things and reports each on its own line:

- the leaf is the hash of the record's chain hash;
- the proof path leads from that leaf to the root the server returned;
- if a root obtained separately was pasted in, whether the served root is that
  root.

They are kept apart because they mean different things. A path that does not
reach the served root is a broken record. A served root that differs from the
one the visitor brought is a server showing a different history from the one
they were given, and the page says that rather than "does not verify".

For a notarised day, the page offers the RFC 3161 response as a `.tsr` download.
The browser does not validate its certificate chain; use an independent RFC 3161
verifier with the downloaded response and published Merkle root. Without an
independently trusted root or timestamp, this page only proves consistency with
the root returned by the same server.
