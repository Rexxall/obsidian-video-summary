# Backend security

## Defaults

- **Local only.** `compose.yaml` publishes n8n on `127.0.0.1` only. Other computers on the network
  cannot reach it.
- **Webhook password.** Every request must carry the `X-Video-Summary-Token` header. The start
  script creates a random 48-character value in `.env` (`VS_WEBHOOK_TOKEN`). It is the
  "connection code" shown to the user.
- **Where the keys live.** Model and speech keys live in `.env` (start script) or, when they are
  chosen in the plugin's settings, in `overrides.json` in the backend's own Docker volume, a file
  only the container user can read. Either way they are also written to n8n's encrypted
  credential store. The container reads `.env` from a read-only mount, so the keys never become
  environment variables of the n8n process.
- **How the plugin hands keys over.** The plugin runs `docker exec -i … configure.mjs apply` and
  writes one JSON object to its standard input, then restarts the container. The keys are in no
  command line, no HTTP request and no n8n execution record. `apply` keeps only a base address, a
  model name and a key per service, and checks them the same way as `.env`. Values handed over
  this way win over `.env`; `.env` stays the fallback.
- **Import file.** `init/configure.mjs` passes the keys to `n8n import:credentials` through a
  temporary file that only the container user can read, and deletes it straight after. It never
  prints a key.
- **n8n hardening.** The compose file also:
  - turns off n8n diagnostics, version checks and personalisation;
  - blocks Code-node access to environment variables and n8n's own files;
  - limits file nodes to the `uploads`, `cookies` and working folders;
  - loads Execute Command, which the media steps need, and keeps the Local File Trigger excluded.

## What the workflows accept

- **Video links.** Only HTTPS links on exact YouTube, Bilibili, Douyin, TikTok and Xiaohongshu
  hostnames. A link reaches yt-dlp only as a validated token, never inside a shell string.
- **Local files.** Only bare file names directly inside `uploads/`.
- **Cookie uploads (`save-cookies`).** Netscape `cookies.txt` lines only, and only for the chosen
  site's own domains. Each site has one fixed file name, and the cookies are never echoed back.

## Remote access

Not supported out of the box. Before exposing the backend beyond `127.0.0.1`:

- put it behind an authenticated HTTPS reverse proxy;
- keep the token;
- add rate limiting;
- review the setup separately.

Never publish port 5678 directly.

## Pinned versions

The `Dockerfile` pins n8n and yt-dlp. Raise them deliberately: read the release notes and security
advisories, then rebuild with `./vs-backend.sh update`. The test suite checks the pins, the
localhost binding and the restricted file roots.
