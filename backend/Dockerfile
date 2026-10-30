# Video Summary backend: n8n plus the media tools the bundled workflows call.
# Releases publish this image for amd64 and arm64 to ghcr.io/rexxall/video-summary-backend; the
# start script builds it locally only when that download fails. It then fills the mirror arguments
# automatically when Docker Hub, npm or PyPI are slow to reach (for example from mainland China);
# leave them empty to use the default registries.
ARG BASE_IMAGE=node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="Video Summary backend" \
	org.opencontainers.image.description="n8n with yt-dlp and ffmpeg for the Video Summary Obsidian plugin" \
	org.opencontainers.image.source="https://github.com/Rexxall/obsidian-video-summary" \
	org.opencontainers.image.licenses="MIT"

ARG N8N_VERSION=2.43.8
ARG YT_DLP_VERSION=2026.10.26
ARG APK_MIRROR=
ARG NPM_REGISTRY=
ARG PIP_INDEX_URL=

USER root

RUN set -eux; \
	if [ -n "${APK_MIRROR}" ]; then \
		sed -i "s#https\?://dl-cdn.alpinelinux.org#${APK_MIRROR}#g" /etc/apk/repositories; \
	fi; \
	apk add --no-cache ca-certificates ffmpeg python3 py3-pip tini tzdata; \
	if [ -n "${PIP_INDEX_URL}" ]; then pip_index="--index-url=${PIP_INDEX_URL}"; else pip_index=""; fi; \
	python3 -m pip install --break-system-packages --no-cache-dir ${pip_index} \
		"yt-dlp[default]==${YT_DLP_VERSION}"; \
	if [ -n "${NPM_REGISTRY}" ]; then npm_registry="--registry=${NPM_REGISTRY}"; else npm_registry=""; fi; \
	npm install -g --omit=dev ${npm_registry} "n8n@${N8N_VERSION}"; \
	npm cache clean --force; \
	mkdir -p /home/node/.n8n /home/node/files /home/node/uploads /home/node/cookies; \
	chown -R node:node /home/node

COPY --chown=node:node init/ /opt/video-summary/init/
COPY --chown=node:node workflows/ /opt/video-summary/workflows/

USER node
WORKDIR /home/node

ENV NODE_ENV=production
EXPOSE 5678

HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=6 \
	CMD wget -q -O /dev/null http://127.0.0.1:5678/healthz || exit 1

ENTRYPOINT ["tini", "--", "/bin/sh", "/opt/video-summary/init/entrypoint.sh"]
