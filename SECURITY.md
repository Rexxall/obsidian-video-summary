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

The plugin does not include private service credentials. Credentials, cookies, model access, download permissions, and transcript generation are handled in the user's n8n workflow or compatible backend.

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
