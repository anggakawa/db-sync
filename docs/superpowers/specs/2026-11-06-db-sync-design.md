# DB Sync: Design

**Date:** 2026-11-06
**Status:** Awaiting review

## Goal

Backing up a development database and restoring it locally is slow and takes
many manual steps. DB Sync is a small Windows desktop app that replaces those
steps with one action: click **Sync** on a saved profile, confirm, and the local
database becomes a copy of the development database.

### Success criteria

- After a profile is set up, a sync needs one click and one confirmation, with
  no dump files or command-line tools to handle.
- The app works right after install, with no database client tools installed.
- The local copy includes the schema, data, triggers, functions and sequences
  (PostgreSQL), or the schema, data, triggers, routines and events
  (MySQL/MariaDB).
- The development database is never written to.
- Nothing except a local database can be overwritten.
- A failed sync never leaves the user without their previous local data, unless
  they turned the backup off for that profile.

## Requirements

| Topic | Decision |
|---|---|
| Engines | PostgreSQL and MySQL/MariaDB |
| Direction | Development to local only, same engine on both sides |
| Source connection | Direct host and port, including over a VPN the user has already started |
| Target | A local install, or a Docker container reached through a published port |
| Sync mode | Full overwrite of the target database |
| Expected size | 1 to 10 GB |
| Platform | Windows |

### Out of scope for the first version

- Incremental merge and table selection
- SQL editor or data browser
- Scheduled syncs
- SSH tunnels and `docker exec` access
- Syncing between different engines, or between MySQL and MariaDB
- Remote targets
- Automatic updates, code signing, and macOS or Linux builds

## Approach

The app runs the official dump and restore tools, which are bundled inside it.
These are the most reliable way to reproduce a schema exactly. Rebuilding DDL by
hand through database drivers was rejected because it risks a copy that silently
differs from development. Relying on tools the user installs was rejected because
it adds setup on each machine.

**Stack:** Electron, TypeScript and React. Node is already available on the
development machine, while Tauri and Wails would need Rust or Go.

## User experience

The app has two screens.

**Profile list.** Each profile has a **Sync** button, its last result, and a
**Restore previous local data** button when a backup exists. During a sync, the
profile shows the current step, progress, a live log and a **Cancel** button.
Failures show a plain message, with raw tool output under **Show details**.

**Profile editor.** Fields:

- Profile name
- Engine: PostgreSQL or MySQL/MariaDB
- Source: host, port, user, password, database name, SSL off or required
- Target: host, port, user, password, database name
- Back up local data before overwriting: on by default
- A **Test connection** button for each side

MySQL and MariaDB are told apart automatically from the server's version string.
SSL is off by default, to match a direct connection on a trusted network, and is
not offered for the target.

The confirmation dialog names the source and target, for example:
"Overwrite `orders` on `localhost:5433` with `orders` from `dev-db:5432`?"

Only one sync can run at a time across all profiles.

## Architecture

| Unit | Responsibility | Depends on |
|---|---|---|
| **UI** (React renderer) | Shows profiles and progress. Has no database or file access and never receives decrypted passwords | Preload API |
| **Profile store** | Saves profiles as JSON and encrypts passwords | Electron `safeStorage` |
| **Target guard** | Decides whether a target may be overwritten | Node DNS lookup |
| **Sync runner** | Runs the steps in order, reports progress, handles cancellation, failure and recovery | Engine adapter interface, target guard |
| **Engine adapters** | Check connections and versions, dump, back up, restore, and replace a database. One for PostgreSQL, one for MySQL/MariaDB | Tool locator, `pg`, `mysql2` |
| **Tool locator** | Returns the path of the correct bundled tool for the engine and server flavor | Bundled tool manifest |
| **Process runner** | Starts tools without a shell, streams their output, removes secrets from logs, and kills process trees | Node `child_process` |

The sync runner does not contain engine-specific logic. A fake adapter
implementing the same interface is used to test the runner.

The source and target are separate types in the adapter interface. The source
type offers only read-only queries and dumping, so there is no code path that
writes to it.

### Electron security

- `contextIsolation` is on and `nodeIntegration` is off.
- The renderer talks to the main process through a small, typed preload API.
- Tools are started with argument arrays and no shell.

### Files on disk

Everything lives in Electron's `userData` folder:

- `profiles.json`: profiles, with passwords encrypted
- `logs/<profile-id>/`: the last 20 sync logs per profile
- `backups/<profile-id>/`: the latest local backup
- `tmp/`: dumps in progress
- `journal/<profile-id>.json`: marks a replace in progress

Backups are unencrypted, like any database dump. They are protected only by the
user's Windows account.

## Sync flow

### Step 1: Check

Results are either blockers, which stop the sync, or warnings, which the user can
accept and continue past.

**Blockers:**

- A connection fails
- The target host fails the target guard
- Source and target are the same database
- MySQL on one side and MariaDB on the other
- A PostgreSQL extension installed on the source is not available on the target
- The target user cannot create databases

**Warnings:**

- The target's major version is older than the source's, so the restore may fail
- Estimated free disk space on the `userData` drive is less than the source size
  plus the target size
- A MySQL/MariaDB source has non-InnoDB tables, which are not covered by the
  consistent snapshot

Free space inside a Docker volume cannot be measured from the host and is not
checked.

### Step 2: Download

The source is dumped to `tmp/`. The target is not touched.

- **PostgreSQL:** `pg_dump -Fd -j 4`, a directory-format dump with 4 workers
- **MySQL/MariaDB:** `mysqldump` or `mariadb-dump` with `--single-transaction
  --routines --triggers --events --hex-blob --no-tablespaces`, gzip-compressed by
  the app as it is written. `--set-gtid-purged=OFF` is added for MySQL only.

For MySQL/MariaDB, `DEFINER` clauses are removed from the dump as it is written,
because those users usually do not exist locally and the restore would fail.

The 4 PostgreSQL workers add load to the shared development server. This is a
fixed value in the first version.

The sync stops if the dump output does not grow for 5 minutes.

### Step 3: Back up local

If the backup setting is on and the target database exists, it is dumped to a
temporary name in `backups/<profile-id>/` with the same tools. It replaces the
previous backup only after it completes. If the backup fails, the sync stops and
the target is untouched.

### Step 4: Replace

1. Check the target guard again.
2. Write the journal file.
3. Close connections to the target database and drop it.
   - **PostgreSQL:** `pg_terminate_backend`, then `DROP DATABASE`, using `WITH
     (FORCE)` on version 13 or later
   - **MySQL/MariaDB:** kill the database's connections from the process list,
     then `DROP DATABASE` with a 30-second `lock_wait_timeout`
4. Create the database.
   - **PostgreSQL:** `TEMPLATE template0` with the source's encoding
   - **MySQL/MariaDB:** the source's default character set and collation
5. Restore the dump.
   - **PostgreSQL:** `pg_restore -j 4 --no-owner --no-privileges --exit-on-error`
   - **MySQL/MariaDB:** decompress the dump into `mysql` or `mariadb`, which stops
     on the first error by default

If the drop is blocked, the sync stops before anything is deleted and reports
what is connected.

`--exit-on-error` is used so that a restore either succeeds completely or is
treated as failed and recovered. Partial success is never reported as success.

### Step 5: Verify

The app compares table lists between source and target. Because development can
change after the snapshot was taken, a difference is a warning rather than a
failure. Row counts are not compared. Then it removes the journal and the dump in
`tmp/`.

## Failure handling

| When | What happens |
|---|---|
| Steps 1 to 3 fail or are cancelled | The sync stops and the target is untouched. Temp files are removed |
| Step 4 fails or is cancelled, backup available | The target is dropped and the backup is restored automatically |
| Step 4 fails or is cancelled, target did not exist before | The partial database is dropped |
| Step 4 fails or is cancelled, backup turned off | The user is told the target may be incomplete and is offered another sync |
| Automatic restore fails | The error is shown, and the backup file and its location are kept |
| App closes during step 4 | The journal is found on next launch, and the app offers the recovery above |
| Leftover temp files | Removed on next launch |

**Cancel** kills the whole tool process tree. Closing the window during a sync
asks for confirmation first.

**Restore previous local data** uses the same replace logic and has its own
confirmation. It does not take a new backup, and the backup is kept afterwards.

Each error message names the failed step and what to do next, for example: "Local
PostgreSQL 15 can't load this dump from dev 17. Upgrade your local image."

## Safety rules

- **Target guard:** the target host must be exactly `localhost`, `127.0.0.1` or
  `::1`. `localhost` must also resolve only to loopback addresses. The check runs
  in the main process, not the UI, and runs again immediately before step 4.
- **Same-database check:** blocked when host, port and database name match after
  normalizing loopback names. Also blocked when the server identities match and
  the database names match, using `system_identifier` on PostgreSQL where it can
  be read and `@@server_uuid` on MySQL/MariaDB.
- **Read-only source:** the source is only used for read-only queries and dump
  tools.
- **Passwords:**
  - Stored with Electron `safeStorage`, which uses Windows DPAPI. If encryption
    is unavailable, the app refuses to save passwords.
  - Passed to PostgreSQL tools through `PGPASSWORD`.
  - Passed to MySQL and MariaDB tools through a temporary `--defaults-file`
    that is deleted after use. It replaces the machine's option files (`my.ini`),
    and the host, port and user go on the command line with a login-path file
    disabled, so nothing on the machine can redirect the tool to another server.
  - Never passed as command-line arguments or written to logs.

### Known limits

- **Forwarded ports:** the guard cannot tell a local database from a `localhost`
  port forwarded to a remote server, such as an SSH tunnel or
  `kubectl port-forward`. Users must not use such a port as a target.
- **Other local databases:** the guard does not stop a profile from overwriting
  another local database, so the confirmation dialog names the target.
- **MySQL tools and non-ASCII text:** MySQL's command-line tools (not MariaDB's)
  receive their arguments in the Windows ANSI code page. A database name with a
  non-ASCII character reaches them mangled, so the check blocks it
  (`unsupported-database-name`). They also cannot open a defaults file from a data
  folder whose name has characters outside that code page, so the check blocks
  that too (`tools-cannot-read-folder`). Both stop the sync before anything is
  dropped, whether or not a backup is on.
- **MySQL events containing `;;`:** MySQL 9.7's `mysqldump` loops forever on an event
  whose body contains `;;`. The check blocks the sync (`event-cannot-be-dumped`)
  when such an event is in the source database or in an existing target database,
  because the backup of the target is a dump too. The message names the event.
  MariaDB's `mariadb-dump` is not affected.
- **MariaDB ed25519:** an account that signs in with the `ed25519` plugin is not
  supported, because the Node driver has no such plugin. DB Sync says so and asks
  for an account with a different sign-in method.
- **PostgreSQL local servers older than the dev server's tool set:** a local
  server at 16 or older cannot receive a copy of a dev server at 17 or newer.
  The sync is refused by the check `target-too-old` ("Local PostgreSQL 14 can't
  load this dump from dev 18. Upgrade your local image."). Within one tool set
  (16 to 14, 18 to 17) an older local server is only a warning, as for the other
  engines.
- **MySQL tools and a non-ASCII install path:** the MySQL tools receive
  `--plugin-dir` in the Windows ANSI code page, so with an install folder outside
  that code page the `mysql_native_password` plugin cannot be found and such
  accounts fail to sign in (a MySQL 9.7 tool limit, not tested).
- **PostgreSQL roles:** roles are not copied. A row-level security policy that
  names a role missing locally fails the restore, and the failure is handled as
  described above.

## Bundled tools

| Engine | Tools | Selection |
|---|---|---|
| PostgreSQL | `pg_dump`, `pg_restore` and required DLLs, for majors 18 (newest stable at build time) and 16 | The 16 tools for a server at 16 or older, the 18 tools for 17 or newer |
| MySQL | `mysqldump`, `mysql` and required DLLs | When the server reports MySQL |
| MariaDB | `mariadb-dump`, `mariadb` and required DLLs | When the server reports MariaDB |

A build script downloads the official Windows archives using a manifest of pinned
versions and SHA-256 hashes, then extracts only the files the app needs.

The MySQL and MariaDB tools are GPL-licensed. This is fine for personal or team
use, but the terms must be reviewed before distributing the app publicly.

## Packaging

The app ships as a Windows NSIS installer built with `electron-builder`. It is
unsigned, so Windows SmartScreen shows a warning on first install.

## Testing

Tests use Vitest.

- **Unit tests:** target guard, same-database check, secret removal from logs,
  `DEFINER` removal, and tool selection.
- **Runner tests:** a fake adapter forces a failure and a cancellation at each
  step and checks every row of the failure table, including recovery from a
  journal after a simulated app close.
- **Integration tests:** full syncs for PostgreSQL, MySQL and MariaDB check that
  tables, data, triggers, functions or routines, and sequences or auto-increment
  values arrive intact.
- **App smoke test:** Playwright launches the packaged app, creates a profile and
  runs a sync.
- **Manual test:** the user runs one trial sync against their real development
  server and local Docker database.

**Test isolation:** integration tests start only temporary database servers from
portable server archives. These run on random ports with data in temp folders.
They never connect to a database the test did not start. A service is already
listening on `localhost:5432` on the development machine, and tests must not touch
it.

## Compatibility results

The risks listed during design were checked with real servers
(`tests/integration/compatibility.test.ts`). The "old" servers are PostgreSQL
14.24, MySQL 8.0.46 and MariaDB 10.11.19, the previous lines a dev server is
likely to run.

- **PostgreSQL 18 tools against older servers:** they do not restore cleanly to a
  server older than 17. `pg_dump` 18 writes `SET transaction_timeout = 0` (new in
  17), which an older server rejects under `--exit-on-error`, and `pg_restore` 14
  to 16 cannot read the 18 archive format. This also broke recovery from the
  backup, because the backup was made with the same tools. The fallback was
  needed: PostgreSQL 16 tools are bundled beside the 18 tools. A server at 16 or
  older uses the 16 tools, and a server at 17 or newer uses the 18 tools. The dump
  of the dev server, the backup of the local database and the restore each follow
  this rule for the server they talk to.
  Tested with real servers (14.24, 16.15, 17.11 and 18.6) and the bundled tools:
  14 to 14, 14 to 16, 16 to 16, 14 to 18, 16 to 18, 17 to 17, 17 to 18 and 18 to 18
  succeed. A newer dev into an older local server with the same tool set
  (16 to 14, 18 to 17) also succeeded. A dev that needs the 18 tools with a local
  server that needs the 16 tools (tested: 18 to 14, 18 to 16 and 17 to 14) is
  blocked by the check `target-too-old` before anything is backed up or dropped,
  with or without a backup. Other versions (15, 13 and older, 19) were not tested;
  15 is assumed to behave like 14 and 16.
- **`--column-statistics=0`:** not needed. MySQL 9.7 `mysqldump` dumps MySQL 9.7 and
  MySQL 8.0 servers without it, and `mariadb-dump` does not use that feature.
- **MySQL 9.7 tools and `mysql_native_password`:** MySQL 9 no longer includes
  this sign-in method in the client, so `mysqldump` could not sign in to a MySQL 8.0
  account that uses it. The client plugin `mysql_native_password.dll` from the same
  archive is now bundled and the MySQL tools get `--plugin-dir`. Accounts that use
  the method now work as source and target.
- **MySQL 9.7 and MariaDB 12.3 against their previous lines:** 8.0 to 8.0, 8.0 to
  9.7, 9.7 to 8.0, 10.11 to 10.11, 10.11 to 12.3 and 12.3 to 10.11 all succeed
  with the bundled tools.
- **Installer size:** the bundled tools take 54.0 MB on disk (PostgreSQL 18 10.6 MB,
  PostgreSQL 16 10.8 MB, MySQL 22.6 MB, MariaDB 10.0 MB), under the 100 MB
  estimate. The installer itself is measured when packaging is built.
