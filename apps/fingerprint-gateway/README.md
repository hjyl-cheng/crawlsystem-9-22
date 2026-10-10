# Fingerprint gateway

Loopback sidecar for the execution Worker. Python 3.12, curl-cffi 0.15.0,
Chrome 136 TLS/HTTP2 impersonation. A leased proxy is required on every request;
direct traffic is enabled only by the explicit test setting.

The Worker encrypts browser identities and cookies on its persistent volume,
restores a profile at lease acquisition, snapshots it after each request, and
removes the in-memory profile when the lease finishes. Cookie and visitor values
never enter heartbeat diagnostics. The gateway has no Kubernetes, PG, MinIO or
Kafka credentials.

Run `npm run check:safe -- fingerprint-gateway` for the Python transport tests,
`collection-unit` for Node integration and collection policy tests, and
`collection-storage` for MinIO persistence and notification recovery checks.
Image builds prepare hash-verified binary wheels with `fingerprint-runtime.ts`.

R2 writes one compressed raw object per channel, complete upload-list scan, or
video (all WEB/IOS attempts and the first comment page). A reference is published
only after storage succeeds. Objects use conditional PUT to prevent late attempts
from replacing completed units. Retries read existing objects and republish;
step manifests are also stored before publication.

During R2 the raw object includes a compatibility projection and the Worker still
submits it through the existing Ingest API. R3 replaces that bridge with independent
parsing and a PG sink, moves comments out of PG, and reconciles manifests against
an ingestion ledger. Search uses its existing path until R4. Automation stays off.
