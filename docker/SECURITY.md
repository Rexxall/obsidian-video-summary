# n8n deployment security

The bundled Compose file publishes n8n only on `127.0.0.1:5678`. Keep that
binding for a single-machine Obsidian setup. The imported workflow intentionally
contains no shared secret, credential identifier, or API key.

The Compose environment also disables n8n diagnostics, blocks Code-node access to environment
variables and n8n's private files, and limits built-in file nodes to the mounted uploads, working,
and cookies directories. n8n 2.35.7 includes the upstream symlink-boundary fixes; do not downgrade
the pinned image.

## Before any remote access

Version 2.4.2 officially supports only the local, same-machine setup. The workflow still requires
Header Auth because other applications on the same computer must not be able to trigger media
downloads or paid model requests. Do not publish port 5678 directly to a LAN or the internet. A
remote deployment is an advanced, separately reviewed setup behind an authenticated HTTPS reverse
proxy.

1. In n8n, create a new Header Auth credential with a freshly generated value. The recommended
   header name is `X-Video-Summary-Token`. Do not store the value in this repository or workflow
   JSON.
2. Open the **Webhook** node and select that credential; Header Auth is already required by the
   public template.
3. Enter the same header name and value in the active Video Summary Webhook profile. The secret is
   stored locally in the plugin's Obsidian settings data and is never included in diagnostics.
4. Keep the host port bound to `127.0.0.1`; let the authenticated TLS proxy be
   the only remote entry point.

Do not weaken or disable the webhook credential. Keep this release local unless an authenticated
gateway and a separate security review protect the remote boundary.

## Local media boundary

`metadata.local_file` accepts only filenames located directly in the mounted
`docker/uploads` directory. Subdirectories, absolute paths, `..`, backslashes,
control characters, and shell metacharacters are rejected. Supported filenames
may contain Unicode letters and numbers, spaces, `.`, `_`, and `-`, and must end
with one of the workflow's explicit media/document extensions. Move a file into
`docker/uploads` and send only its basename (for example, `课程 01.mp4`).

## Pinned runtime

`n8n-video-summary.Dockerfile` pins n8n `2.35.7` and yt-dlp `2026.8.19`. Update those pins
deliberately, review their security advisories and release notes, then rebuild the image. The
workflow test suite verifies the expected pins, restricted file roots, and localhost-only port
mapping.
