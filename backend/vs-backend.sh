#!/usr/bin/env bash
# Video Summary backend for macOS and Linux.
#   ./vs-backend.sh          start (first run: creates .env, asks for API keys, downloads the image)
#   ./vs-backend.sh code     print the connection code again and copy it
#   ./vs-backend.sh check    ask the running backend whether model and speech-to-text work
#   ./vs-backend.sh keys     enter or change API keys, then restart
#   ./vs-backend.sh logs     follow the backend log
#   ./vs-backend.sh stop     stop the backend (data is kept)
#   ./vs-backend.sh update   download the image for this version again (or rebuild), then restart
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env

say() { printf '%s\n' "$*"; }
die() {
	printf '\n✗ %s\n' "$*" >&2
	exit 1
}

env_get() {
	[ -f "$ENV_FILE" ] || return 0
	awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

env_set() {
	local tmp
	tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
	KEY="$1" VALUE="$2" awk -F= '
		BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
		$1 == key { print key "=" value; done = 1; next }
		{ print }
		END { if (!done) print key "=" value }
	' "$ENV_FILE" >"$tmp"
	chmod 600 "$tmp"
	mv "$tmp" "$ENV_FILE"
}

random_token() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 24
	else
		head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
	fi
}

port() { env_get VS_PORT | grep -E '^[0-9]+$' || echo 5678; }
connection_code() {
	printf 'http://127.0.0.1:%s/webhook/obsidian-video-summary#token=%s' "$(port)" "$(env_get VS_WEBHOOK_TOKEN)"
}

copy_to_clipboard() {
	if command -v pbcopy >/dev/null 2>&1; then
		printf '%s' "$1" | pbcopy && return 0
	elif command -v wl-copy >/dev/null 2>&1; then
		printf '%s' "$1" | wl-copy && return 0
	elif command -v xclip >/dev/null 2>&1; then
		printf '%s' "$1" | xclip -selection clipboard && return 0
	fi
	return 1
}

compose() { docker compose --env-file "$ENV_FILE" "$@"; }

require_docker() {
	command -v docker >/dev/null 2>&1 ||
		die "没有找到 Docker。请先安装 Docker Desktop（Windows/macOS）或 OrbStack（macOS），打开它，再运行本脚本。"
	docker info >/dev/null 2>&1 ||
		die "Docker 没有在运行。请先打开 Docker Desktop 或 OrbStack，等它显示运行中，再运行本脚本。"
	docker compose version >/dev/null 2>&1 || die "这个 Docker 版本没有 docker compose，请升级 Docker Desktop。"
}

ensure_env() {
	if [ ! -f "$ENV_FILE" ]; then
		cp .env.example "$ENV_FILE"
		chmod 600 "$ENV_FILE"
		say "已创建 .env（后端设置都在这个文件里）。"
	fi
	if ! env_get VS_WEBHOOK_TOKEN | grep -Eq '^[A-Za-z0-9_-]{24,}$'; then
		env_set VS_WEBHOOK_TOKEN "$(random_token)"
	fi
}

ask_key() {
	local key="$1" label="$2" where="$3" value
	printf '\n%s\n  申请地址：%s\n  粘贴后回车（输入不会显示；直接回车表示暂时跳过）：' "$label" "$where"
	IFS= read -rs value || true
	printf '\n'
	value="$(printf '%s' "$value" | tr -d '[:space:]')"
	if [ -n "$value" ]; then
		env_set "$key" "$value"
		say "  已保存。"
	fi
}

ask_keys() {
	local force="${1:-}"
	[ -t 0 ] || return 0
	if [ -n "$force" ] || [ -z "$(env_get VS_CHAT_API_KEY)" ]; then
		ask_key VS_CHAT_API_KEY "① 总结用的模型密钥（默认 DeepSeek，地址 $(env_get VS_CHAT_BASE_URL)）" \
			"https://platform.deepseek.com/api_keys"
	fi
	if [ -n "$force" ] || [ -z "$(env_get VS_SPEECH_API_KEY)" ]; then
		ask_key VS_SPEECH_API_KEY "② 语音转写密钥（默认硅基流动，SenseVoice 免费；没有字幕的视频和本地音视频要用）" \
			"https://cloud.siliconflow.cn/account/ak"
	fi
}

port_busy() {
	if command -v lsof >/dev/null 2>&1; then
		lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
	else
		(exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
	fi
}

choose_port() {
	if [ -n "$(compose ps -q --status running n8n 2>/dev/null)" ]; then return 0; fi
	local p
	p="$(port)"
	if port_busy "$p"; then
		local candidate=$((p + 1))
		while [ "$candidate" -lt $((p + 40)) ] && port_busy "$candidate"; do candidate=$((candidate + 1)); done
		say "端口 $p 已被别的程序占用（可能是你自己的 n8n），改用 $candidate。"
		env_set VS_PORT "$candidate"
	fi
}

choose_mirrors() {
	local mode
	mode="$(env_get VS_MIRROR)"
	mode="${mode:-auto}"
	if [ "$mode" = auto ]; then
		if curl -s -m 6 -o /dev/null https://registry-1.docker.io/v2/; then mode=global; else mode=cn; fi
	fi
	if [ "$mode" = cn ]; then
		say "使用国内镜像构建（Docker Hub 连不上或已设为 cn）。"
		export VS_BASE_IMAGE="${VS_BASE_IMAGE:-docker.m.daocloud.io/library/node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85}"
		export VS_APK_MIRROR="${VS_APK_MIRROR:-https://mirrors.aliyun.com}"
		export VS_NPM_REGISTRY="${VS_NPM_REGISTRY:-https://registry.npmmirror.com}"
		export VS_PIP_INDEX_URL="${VS_PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}"
	fi
}

# Where the prebuilt image lives, for a quick reachability check before pulling.
image_ref() { compose config --images 2>/dev/null | head -n 1; }
registry_url() {
	local host="${1%%/*}"
	case "$host" in
	localhost* | 127.0.0.1*) printf 'http://%s/v2/' "$host" ;;
	*.*) printf 'https://%s/v2/' "$host" ;;
	*) printf 'https://registry-1.docker.io/v2/' ;;
	esac
}

# Download the prebuilt image; build it here only when the download is not possible.
get_image() {
	local mode ref
	mode="$(env_get VS_MIRROR)"
	ref="$(image_ref)"
	if [ "${mode:-auto}" != cn ] && curl -s -m 6 -o /dev/null "$(registry_url "$ref")"; then
		say "下载预构建的后端镜像（约 550 MB，第一次通常 1–5 分钟）…"
		if compose pull n8n; then return 0; fi
		say "预构建镜像下载失败，改为在本机构建。"
	fi
	choose_mirrors
	say "在本机构建后端（第一次约 10 分钟）…"
	compose build "$@" n8n
}

wait_ready() {
	local url code deadline
	url="http://127.0.0.1:$(port)/webhook/obsidian-video-summary"
	deadline=$((SECONDS + 600))
	printf '等待后端就绪'
	while [ "$SECONDS" -lt "$deadline" ]; do
		code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$url" \
			-H 'Content-Type: application/json' \
			-H "X-Video-Summary-Token: $(env_get VS_WEBHOOK_TOKEN)" \
			-d '{"name":"test","metadata":{}}' || true)"
		if [ "$code" = 200 ]; then
			printf ' 好了。\n'
			return 0
		fi
		if [ -z "$(compose ps -q --status running n8n 2>/dev/null)" ] && [ "$SECONDS" -gt 20 ]; then
			printf '\n'
			compose logs --tail 30 n8n || true
			die "后端没有起来，上面是最后的日志。常见原因见教程的排错表。"
		fi
		printf '.'
		sleep 3
	done
	printf '\n'
	die "等了 10 分钟后端还没就绪。运行 ./vs-backend.sh logs 看日志。"
}

show_code() {
	local code
	code="$(connection_code)"
	say ""
	say "连接码（在 Obsidian → 设置 → 视频总结 → 首次配置 里粘贴）："
	say ""
	say "  $code"
	say ""
	if copy_to_clipboard "$code"; then say "已复制到剪贴板。"; fi
	say "这串连接码相当于后端的口令，不要发给别人。"
}

check() {
	compose exec -T n8n node /opt/video-summary/init/check.mjs
}

start() {
	require_docker
	ensure_env
	ask_keys
	choose_port
	if ! docker image inspect "$(image_ref)" >/dev/null 2>&1; then get_image; fi
	say "启动后端…"
	compose up -d --no-build
	wait_ready
	show_code
}

case "${1:-start}" in
start) start ;;
code)
	ensure_env
	show_code
	;;
check) check ;;
keys)
	require_docker
	ensure_env
	ask_keys force
	compose up -d
	wait_ready
	;;
logs) compose logs -f --tail 100 n8n ;;
stop) compose stop ;;
update)
	require_docker
	ensure_env
	get_image --pull
	compose up -d --no-build
	wait_ready
	show_code
	;;
*) die "不认识的命令：$1（可用：start code check keys logs stop update）" ;;
esac
