# LinkOK PC Hub

The PC side of LinkOK: a single Node process that owns the canonical state, accepts
the Phone's connection over the LAN, and serves the settings page.

- **Runtime**: Node.js **24** (developed against v24.19.0). No build step.
- **Dependencies**: one, `qrcode` (pure JS). There are no native modules and nothing
  to compile — `node-gyp` is never invoked.
- **Wire contract**: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md). Where this README and
  PROTOCOL disagree, PROTOCOL wins.

---

## Quick start

```powershell
cd pc
npm install          # only needed once; installs the pure-JS qrcode package
node src/main.js     # or: npm start
```

The Hub logs its port and the addresses to open:

```
LinkOK Hub 0.1.0 is running
  settings   http://127.0.0.1:8787
  LAN        http://192.168.1.100:8787
  health     http://127.0.0.1:8787/health
  data       C:\Users\<you>\AppData\Local\LinkOK
  paired     no
  helper     unavailable
```

Open the **settings** URL on the PC. To pair the Phone, use *配对新设备* on the
settings page or the Tray; a 6-character Pairing Code and a `linkok://pair?...`
payload are shown, valid for 120 seconds and usable exactly once.

> The settings page and `/health` work even when `pc/helper/linkok-helper.exe` has
> not been compiled yet. The Hub reports `helper: "unavailable"` and keeps serving;
> only clipboard image/text, the Tray and Windows notifications are degraded.

---

## Command line

```
node src/main.js [--port <1-65535>] [--no-helper] [--verbose]
```

| Flag | Effect |
|---|---|
| `--port <n>` | Bind this port **for this run only**. It is never written to `config.json`, so a one-off experiment cannot silently rewrite your setting. |
| `--no-helper` | Never spawn the native helper (useful for tests and for running the Hub on a machine without it). |
| `--verbose` | Log at `debug`. Same as `LINKOK_LOG_LEVEL=debug`. |

Exit codes: `0` clean shutdown · `2` port already in use · `3` other startup failure.
A busy port prints a Chinese explanation naming the port and suggesting `--port`
rather than dumping a stack trace.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LINKOK_DATA_DIR` | `%LOCALAPPDATA%\LinkOK` | Overrides the whole data directory. **This is the one to set** for a portable install, a second instance, or tests. |
| `LINKOK_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. `debug` logs every suppressed Echo and every clipboard decision. |
| `LOCALAPPDATA` / `USERPROFILE` | — | Used to derive the default data directory when `LINKOK_DATA_DIR` is unset. |

The native helper honours its own overrides (`LINKOK_SCREENSHOT_DIR`,
`LINKOK_HELPER_LOG`, `LINKOK_HELPER_TMP`); the Hub sets `LINKOK_HELPER_TMP` to
`<data>\tmp` automatically so the helper never falls back to an unwritable `%TEMP%`.

---

## Ports

| Port | Use |
|---|---|
| **8787** | HTTP + WebSocket (`/`, `/health`, `/api/*`, `/ws`). Configurable via `config.json` or `--port`. |
| **8788** | UDP re-discovery (broadcast). |

The Hub binds `0.0.0.0` on purpose: binding `127.0.0.1` would make the Phone unable to
connect. There is no TLS — this is a LAN-only tool and the Token is the security
boundary.

A `port` change through `PATCH /api/config` is **accepted and persisted but applied on
the next start**; rebinding a live listener would drop the Phone's Link. The Hub logs
a warning when this happens.

---

## Data directory layout

```
%LOCALAPPDATA%\LinkOK\
├── config.json                  # the Config object (PROTOCOL §7)
├── device.json                  # Token + bound Phone + this install's id
├── history\
│   ├── index.json               # {"version":1,"items":[HistoryItem]}
│   └── 2026-11-25\
│       └── 20261125T164651132-3f2a1b.png
├── logs\
│   └── hub-2026-11-25.log       # one file per day, plus stdout
└── tmp\                         # helper scratch (clipboard PNG spill)
```

- `config.json` holds **no secrets**, so it is safe to show in the settings page.
- `device.json` holds the Token. Deleting it revokes the pairing: the Phone must pair
  again. It also stores an `instanceId` — the `fp` the Phone uses to recognise *this*
  PC — so a Token revoke does not make the Phone think it found a different machine.
- **Every** JSON write is atomic: `*.tmp` → `fsync` → `rename`. On Windows a rename can
  fail with `EPERM` while another handle holds the target open (antivirus, Explorer
  preview, a reader), so the rename is retried briefly instead of losing the update.

---

## HTTP and WebSocket surface

Unauthenticated endpoints are exactly three: `GET /`, `GET /health`, `POST /pair`
(PROTOCOL §2). Everything else requires `Authorization: Bearer <token>` and otherwise
returns `401 {"error":"unauthorized"}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ok, version, paired}` — no auth |
| GET | `/` | settings page — no auth; also sets the `linkok_token` HttpOnly cookie so the page's own `fetch` is authenticated |
| POST | `/pair` | `{code, deviceName, deviceModel}` → `{token}` |
| GET | `/api/state` | config + link + helper + `paused` + `paired` |
| PATCH | `/api/config` | partial config → full config |
| GET | `/api/history?from=&to=&limit=` | newest-first list |
| GET | `/api/history/:id/raw` | the PNG |
| DELETE | `/api/history/:id` | delete one Capture |
| POST | `/api/history/:id/copy` | put that Capture back on the PC clipboard |
| POST | `/api/pairing-code` | `{code, expiresAt, qrPayload, qrSvg}` |
| POST | `/api/device/revoke` | mint nothing, revoke the Token |
| POST | `/api/sync` | `{"paused": bool}` |
| POST | `/api/reveal` | `{"target":"history"\|"storage","id"?}` |
| WS | `/ws` | the Link |

`POST /api/history/:id/copy`, `POST /api/reveal` and `POST /api/sync` are additions
beyond PROTOCOL §3: the settings page needs them (SPEC §6.3), and the browser cannot
provide them itself — `navigator.clipboard` is unavailable on an insecure LAN origin,
and a web page cannot open Explorer.

Errors are always `{"error":"<machine_readable>", "message":"<中文>"}`.

### WebSocket

`ws://<host>:8787/ws` with the Bearer Token **in the handshake header**. An
unauthenticated upgrade gets `401` and deliberately **no** `Sec-WebSocket-Accept`.
Exactly one Link exists at a time: a new connection closes the previous one with
`1000`. Captures larger than 1 MB travel as 256 KB chunks (`chunk` header + binary
frame). Control messages are JSON text frames.

---

## Behaviour worth knowing

**Dedup.** A Capture is identified by the SHA-256 of its full image bytes. Anything
whose hash is already in History is dropped and acknowledged, never delivered twice —
including the same image arriving from both the clipboard and the screenshot folder.

**Echo suppression (hard invariant).** The Hub remembers the hash of every text it
wrote to the PC clipboard *and* every text it sent to the Phone. When a clipboard
message arrives carrying either hash it is dropped. Without this the two devices would
overwrite each other's clipboard forever. The helper also suppresses the echo of its
own clipboard writes, so the guard is belt-and-braces.

**Retention.** Choices are `7`, `15`, `30` or `0` (= Never); anything else is a `400`.
The sweep runs at startup and hourly, measures from **Arrival Time**, and only ever
deletes files that resolve *inside* `<data>\history`. `0` performs no deletion at all.

**Offline Captures.** A PC Capture made while the Phone is disconnected is stored in
History and replayed, in order, on the next connection. It is not silently dropped.

**Serial delivery.** Only one Capture is in flight; the next waits for
`capture-result` or a 10-second timeout (PROTOCOL §12).

**Helper supervision.** The helper is spawned with
`stdio: ['pipe','pipe','pipe']` and spoken to in newline-delimited JSON. A crash
restarts it with 2 s → 4 s → 5 s backoff; after 5 consecutive failures the Hub stops
trying, notifies once, and keeps serving with `helper: "unavailable"`. A missing
binary is **not** an error — it is a supported degraded mode. A quit from the Tray is
not a crash and is not restarted.

---

## Tests

```powershell
cd pc
npm test
```

```powershell
# same suite, one line per test
npm run test:verbose
```

Tests use the built-in `node:test` runner and need no network. They write only under
`pc/.test-tmp`, which is removed on exit — never into `%LOCALAPPDATA%`.

Coverage of the requirements that are easy to get subtly wrong:

| Area | File |
|---|---|
| Token constant-time comparison, Token/指纹 generation, UTF-8 truncation | `test/crypto-util.test.js` |
| Pairing Code TTL, single use, 5-failure lockout, Hub identity | `test/pairing.test.js` |
| Config defaults, `retentionDays` validation, repair of a corrupt file | `test/config.test.js` |
| Dedup, Retention boundary (`0` = never), atomic `index.json` | `test/history-store.test.js` |
| Chunk reassembly, gaps, size caps | `test/chunk-assembler.test.js` |
| Echo suppression in both directions | `test/echo-guard.test.js` |
| Helper supervision, crash restart, give-up, missing binary | `test/helper-supervisor.test.js` |
| Every endpoint's 401, cookies, traversal, status codes | `test/http-server.test.js` |
| WS handshake auth, chunked transfer, echo, single connection | `test/ws-link.test.js` |
| Time and colon-free id formatting | `test/time.test.js` |

### Live end-to-end check

With the Hub already running (and a Pairing Code visible in its banner or on the
settings page):

```powershell
node test/smoke.js http://127.0.0.1:8787 ABC123
```

It verifies `/health`, the 401 on `/api/state`, the settings page, pairing, an
authenticated `/api/state`, the Retention validation, a real WebSocket handshake, a
full Capture round trip and that History contains the result. It only adds one
Capture and deletes nothing.

> **Sandbox note.** If you run this inside a restricted environment, `spawn` of an
> external process with `stdio: 'pipe'` may fail with `EPERM` (named pipes are
> blocked). That is why the test suite drives the helper supervisor through an
> injected fake child, and why the Hub treats "cannot spawn the helper" as a
> degraded mode rather than a fatal error. The real helper works normally on a
> normal Windows desktop session.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `端口 8787 已被占用` (exit 2) | Another process holds the port. `node src/main.js --port 8790`, or change it on the settings page and restart. |
| `helper: "unavailable"`, reason `binary-missing` | `pc/helper/linkok-helper.exe` has not been built. The Hub still works; clipboard/Tray/notifications do not. |
| Helper keeps restarting | Check `<data>\logs\hub-*.log` and the helper's own log. A second instance exits immediately by design (single-instance mutex). |
| The Phone cannot connect | Confirm both devices are on the same Wi-Fi and that Windows Firewall allows Node on port 8787 (private networks only). The QR payload must contain the LAN address, not `127.0.0.1`. |
| QR code points at the wrong address | The Hub picks the best private IPv4 adapter; a VPN or a virtual adapter can win. Disconnect it, or use `--port`/the payload text instead of the QR. |
| Clipboard does not update | The helper is down, or the text was correctly suppressed as an Echo — check with `LINKOK_LOG_LEVEL=debug`. |
