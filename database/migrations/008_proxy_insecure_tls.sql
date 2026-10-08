-- HTTPS proxies whose own certificate cannot be verified (Clash lists mark them
-- skip-cert-verify; typically IP endpoints with a certificate for a hostname). A source
-- must opt in, and only credential-free endpoints may skip the check, so no secret is
-- ever sent over an unverified hop. The TLS tunnelled to the target is always verified.
-- Additive only, so Control builds without this change keep working against it.
ALTER TABLE m1.proxy_sources ADD COLUMN allow_insecure_tls boolean NOT NULL DEFAULT false;
ALTER TABLE m1.proxies ADD COLUMN tls_insecure boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT proxies_tls_insecure CHECK (NOT tls_insecure OR (protocol = 'https' AND username IS NULL AND credential IS NULL));
