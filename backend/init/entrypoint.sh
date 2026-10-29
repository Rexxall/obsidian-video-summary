#!/bin/sh
# Configure credentials and workflows from the mounted .env, then hand over to n8n.
# configure.mjs exits non-zero only for a broken package; missing API keys still start n8n so
# the plugin's setup check can say what to fill in.
set -eu

node /opt/video-summary/init/configure.mjs

exec n8n start
