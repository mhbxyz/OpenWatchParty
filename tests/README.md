# Tests

Test suites and fixtures.

## Harness protocole (PoC)

```bash
uv sync --group tests
.venv/bin/python protocol_harness.py --ws ws://localhost:8999/ws
```

Ou via Makefile:

```bash
make test-harness
```

Via Docker:

```bash
docker compose run --rm protocol-harness
```

Si `JWT_SECRET` est défini pour le serveur, exporte la même valeur avant le test.
Si `HOST_ROLES` est défini, le harness utilise le premier rôle pour le host.
