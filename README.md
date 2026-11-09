# DB Sync

A Windows desktop app that overwrites a local database with a copy of a development
database. PostgreSQL and MySQL/MariaDB, development to local only, same engine on both
sides. It runs the official dump and restore tools, which are bundled in the installer.

## Safety rules

- The target host must be exactly `localhost`, `127.0.0.1` or `::1`, and `localhost`
  must resolve only to loopback addresses. This is checked in the main process, and
  again just before the target is dropped.
- A sync is blocked when source and target are the same database.
- The source only receives read-only queries and dump tools.
- Passwords are stored with Windows DPAPI (Electron `safeStorage`), are never passed
  as command-line arguments and are never written to logs.
- The local data is backed up first (unless turned off per profile) and put back if the
  sync fails. **Restore previous local data** brings back the last backup.

## Known limits

- **Forwarded ports:** the guard cannot tell a local database from a `localhost` port
  forwarded to a remote server (SSH tunnel, `kubectl port-forward`). Never use one as a target.
- **Other local databases:** the guard does not stop a profile from overwriting another
  local database. The confirmation dialog names the target; read it.
- **MySQL tools and non-ASCII text:** a database name with a non-ASCII character, or a
  data folder whose name has characters outside the Windows ANSI code page, is blocked
  (`unsupported-database-name`, `tools-cannot-read-folder`). MariaDB is not affected.
  A non-ASCII install path can stop `mysql_native_password` accounts from signing in
  (not tested).
- **MySQL events containing `;;`:** MySQL 9.7 `mysqldump` loops on them, so the sync is
  blocked (`event-cannot-be-dumped`).
- **MariaDB ed25519:** accounts using the `ed25519` plugin are not supported.
- **PostgreSQL local server older than the dev server's tools:** a local server at 16 or
  older cannot receive a copy of a dev server at 17 or newer (`target-too-old`). Tested
  versions: 14, 16, 17 and 18; others (15, 13 and older, 19) were not tested.
- **PostgreSQL roles are not copied.** A row-level security policy naming a role that is
  missing locally fails the restore.

## Not verified or weaker than you might assume

- **Tool downloads:** the PostgreSQL tool SHA-256 hashes in `tools/manifest.json` are
  first-download pins; EDB publishes no checksum, so they prove the file did not change
  since it was first fetched, not that it was genuine. MySQL's archive is checked against
  the vendor's MD5 only. MariaDB's matches the vendor's SHA-256 list.
- **TLS to dev does not verify certificates.** "SSL: Required" encrypts the connection
  but accepts any certificate, so it does not protect against an impersonated server.
- **Backups and dumps on disk are unencrypted**, protected only by your Windows account.
- **The installer is unsigned.** Windows SmartScreen warns on first install.
- Windows x64 only. Not tested on a machine other than the development one.
- **Real dev servers and Docker were never used in testing.** Every automated test uses
  throwaway servers started by the test itself. Run the manual trial below.

## Licenses

The bundled MySQL and MariaDB command-line tools are GPL-licensed. That is fine for
personal or team use; review the terms before distributing the app publicly.

## Build

```
npm install
npm run fetch-tools    # downloads the pinned tool archives into resources/tools
npm run dist           # builds out/ and the installer into release/
```

The installer is `release/DB Sync Setup 0.1.0.exe`; `release/win-unpacked` is the same
app unpacked. The Electron binary is downloaded the first time it is needed.

## Tests

```
npm run typecheck
npm test                  # unit tests
npm run test:integration  # real servers; runs every integration file whatever filter is given
npm run test:smoke        # drives release/win-unpacked, so run npm run dist first
```

Integration and smoke tests start their own temporary servers on random loopback ports
from portable archives in `.cache/servers`, and never connect to anything else. A service
listening on `localhost:5432` on your machine is never touched.
`DBSYNC_USER_DATA` points the app at a different data folder (used by the smoke test).

## Manual trial (yours to run)

1. Install the app and create a profile from the real dev server to a local test database
   in Docker (published port on `localhost`; use a database you can afford to lose).
2. Run a sync, and check that the data looks right with your own tools.
3. Run **Restore previous local data**, and check that the old data is back.
