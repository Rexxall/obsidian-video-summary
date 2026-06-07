FROM node:24-alpine

ARG N8N_VERSION=2.23.4

USER root

RUN apk add --no-cache \
		bash \
		ffmpeg \
		python3 \
		py3-pip \
		tini \
	&& python3 -m pip install --break-system-packages --no-cache-dir --upgrade pip yt-dlp \
	&& npm install -g "n8n@${N8N_VERSION}" \
	&& mkdir -p /home/node/.n8n /home/node/files /home/node/uploads /home/node/cookies \
	&& chown -R node:node /home/node

USER node

ENV N8N_HOST=0.0.0.0
ENV N8N_PORT=5678
ENV N8N_PROTOCOL=http
ENV NODE_ENV=production

EXPOSE 5678

ENTRYPOINT ["tini", "--"]
CMD ["n8n", "start"]
