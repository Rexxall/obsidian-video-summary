# Security Policy

## Supported versions

The latest release is supported. Older releases may receive fixes if the issue is severe and the fix is low risk.

## Data handling

Video Summary sends selected note data to the endpoint configured by the user. Depending on the selected mode, this can include:

- note name
- video URL
- pasted transcript
- local media path
- selected language
- processing mode
- processing model label

The public repository and workflow do not include private service credentials. Model credentials,
cookies, download permissions, and transcript generation are handled in the user's n8n workflow or
compatible backend. A per-profile Webhook Header Auth secret can be stored locally in the plugin's
`data.json`; it is not encrypted by the plugin and is redacted from connection diagnostics.

## Verifying a release

Every file attached to a release from 2.12.1 on, and every backend image, carries a signed build
provenance attestation from the release workflow. Check a download with
`gh attestation verify main.js --repo Rexxall/obsidian-video-summary`, or the image with
`gh attestation verify oci://ghcr.io/rexxall/video-summary-backend:<version> --repo Rexxall/obsidian-video-summary`.

## Reporting a vulnerability

Please open a GitHub issue with a concise description and reproduction steps if the issue does not expose private data.

If the report includes credentials, tokens, private links, or personal transcripts, do not post them publicly. Create a minimal reproduction and state that private details can be shared privately if needed.

## Publication safety

Before publishing a workflow export or release, confirm that it does not contain:

- real credentials
- cookies
- local absolute vault paths
- personal transcript content
- private webhook URLs
- cached processing data

## Self-hosted backend safety

Treat every webhook field, video URL, filename, redirect, subtitle, and model response as untrusted
input. Never interpolate request data into a shell command. Use fixed executables with argument
arrays, strict URL host allowlists, and path confinement below an explicit upload or media root.
Asset URLs in a backend reply are never fetched.

The bundled Docker setup is intended for one-user local use, publishes n8n only on `127.0.0.1`, and
still requires Header Auth to prevent untrusted local applications from triggering work. Do not
expose it directly to a LAN or the public internet. A remote deployment needs
TLS, authentication, rate limiting, current n8n security updates, and an operator who understands
the data sent to video, transcription, and AI providers.

Keep the n8n image version current. A version bump is not complete until the bundled workflow has
passed its static checks and a clean local integration test against that image.
