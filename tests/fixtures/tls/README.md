Test-only PKI for `tests/e2e/https-ca.spec.ts`: a private root (`ca.pem`), a leaf for
127.0.0.1/localhost signed by it (`server.pem`, `server-key.pem`), and an unrelated
root (`other-ca.pem`). The root keys were discarded; nothing here is trusted anywhere else.
