# Video Summary backend for Windows (PowerShell 5.1 or newer).
#   .\vs-backend.ps1          start (first run: creates .env, asks for API keys, downloads the image)
#   .\vs-backend.ps1 code     print the connection code again and copy it
#   .\vs-backend.ps1 check    ask the running backend whether model and speech-to-text work
#   .\vs-backend.ps1 keys     enter or change API keys, then restart
#   .\vs-backend.ps1 logs     follow the backend log
#   .\vs-backend.ps1 stop     stop the backend (data is kept)
#   .\vs-backend.ps1 update   download the image for this version again (or rebuild), then restart
param([string]$Command = 'start')

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$EnvFile = Join-Path $PSScriptRoot '.env'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$Message) {
	Write-Host ''
	Write-Host "✗ $Message" -ForegroundColor Red
	exit 1
}

function Get-EnvValue([string]$Key) {
	if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
	foreach ($line in [System.IO.File]::ReadAllLines($EnvFile, $Utf8)) {
		if ($line.StartsWith("$Key=")) { return $line.Substring($Key.Length + 1).Trim() }
	}
	return ''
}

function Set-EnvValue([string]$Key, [string]$Value) {
	$lines = [System.Collections.Generic.List[string]]::new()
	$done = $false
	foreach ($line in [System.IO.File]::ReadAllLines($EnvFile, $Utf8)) {
		if ($line.StartsWith("$Key=")) { $lines.Add("$Key=$Value"); $done = $true } else { $lines.Add($line) }
	}
	if (-not $done) { $lines.Add("$Key=$Value") }
	[System.IO.File]::WriteAllLines($EnvFile, $lines, $Utf8)
}

function New-Token {
	$bytes = New-Object byte[] 24
	[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
	return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-Port {
	$value = Get-EnvValue 'VS_PORT'
	if ($value -match '^\d+$') { return [int]$value } else { return 5678 }
}

function Get-ConnectionCode {
	return "http://127.0.0.1:$(Get-Port)/webhook/obsidian-video-summary#token=$(Get-EnvValue 'VS_WEBHOOK_TOKEN')"
}

function Invoke-Compose {
	& docker compose --env-file $EnvFile @args
	if ($LASTEXITCODE -ne 0) { Fail "docker compose $($args -join ' ') 失败。" }
}

function Test-Docker {
	if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
		Fail '没有找到 Docker。请先安装 Docker Desktop，打开它，再运行本脚本。'
	}
	& docker info *> $null
	if ($LASTEXITCODE -ne 0) { Fail 'Docker 没有在运行。请先打开 Docker Desktop，等它显示 Engine running，再运行本脚本。' }
}

function Initialize-Env {
	if (-not (Test-Path -LiteralPath $EnvFile)) {
		Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $EnvFile
		Write-Host '已创建 .env（后端设置都在这个文件里）。'
	}
	if ((Get-EnvValue 'VS_WEBHOOK_TOKEN') -notmatch '^[A-Za-z0-9_-]{24,}$') {
		Set-EnvValue 'VS_WEBHOOK_TOKEN' (New-Token)
	}
}

function Read-Key([string]$Key, [string]$Label, [string]$Where) {
	Write-Host ''
	Write-Host $Label
	Write-Host "  申请地址：$Where"
	$secure = Read-Host '  粘贴后回车（输入不会显示；直接回车表示暂时跳过）' -AsSecureString
	$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
		[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
	$plain = ($plain -replace '\s', '')
	if ($plain) { Set-EnvValue $Key $plain; Write-Host '  已保存。' }
}

function Read-Keys([switch]$Force) {
	if ($Force -or -not (Get-EnvValue 'VS_CHAT_API_KEY')) {
		Read-Key 'VS_CHAT_API_KEY' "① 总结用的模型密钥（默认 DeepSeek，地址 $(Get-EnvValue 'VS_CHAT_BASE_URL')）" 'https://platform.deepseek.com/api_keys'
	}
	if ($Force -or -not (Get-EnvValue 'VS_SPEECH_API_KEY')) {
		Read-Key 'VS_SPEECH_API_KEY' '② 语音转写密钥（默认硅基流动，SenseVoice 免费；没有字幕的视频和本地音视频要用）' 'https://cloud.siliconflow.cn/account/ak'
	}
}

function Test-PortBusy([int]$Port) {
	return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Select-Port {
	$running = & docker compose --env-file $EnvFile ps -q --status running n8n 2>$null
	if ($running) { return }
	$port = Get-Port
	if (Test-PortBusy $port) {
		$candidate = $port + 1
		while ($candidate -lt $port + 40 -and (Test-PortBusy $candidate)) { $candidate++ }
		Write-Host "端口 $port 已被别的程序占用（可能是你自己的 n8n），改用 $candidate。"
		Set-EnvValue 'VS_PORT' "$candidate"
	}
}

function Select-Mirrors {
	$mode = Get-EnvValue 'VS_MIRROR'
	if (-not $mode) { $mode = 'auto' }
	if ($mode -eq 'auto') {
		try {
			Invoke-WebRequest -Uri 'https://registry-1.docker.io/v2/' -TimeoutSec 6 -UseBasicParsing | Out-Null
			$mode = 'global'
		} catch {
			if ($_.Exception.Response) { $mode = 'global' } else { $mode = 'cn' }
		}
	}
	if ($mode -eq 'cn') {
		Write-Host '使用国内镜像构建（Docker Hub 连不上或已设为 cn）。'
		if (-not $env:VS_BASE_IMAGE) { $env:VS_BASE_IMAGE = 'docker.m.daocloud.io/library/node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85' }
		if (-not $env:VS_APK_MIRROR) { $env:VS_APK_MIRROR = 'https://mirrors.aliyun.com' }
		if (-not $env:VS_NPM_REGISTRY) { $env:VS_NPM_REGISTRY = 'https://registry.npmmirror.com' }
		if (-not $env:VS_PIP_INDEX_URL) { $env:VS_PIP_INDEX_URL = 'https://mirrors.aliyun.com/pypi/simple/' }
	}
}

function Get-ImageRef {
	$images = & docker compose --env-file $EnvFile config --images 2>$null
	return ($images | Select-Object -First 1)
}

# Download the prebuilt image; build it here only when the download is not possible.
function Get-Image([switch]$PullBase) {
	$mode = Get-EnvValue 'VS_MIRROR'
	$ref = Get-ImageRef
	$hostName = ($ref -split '/')[0]
	$registry = if ($hostName -like 'localhost*' -or $hostName -like '127.0.0.1*') { "http://$hostName/v2/" } else { "https://$hostName/v2/" }
	$reachable = $false
	if ($mode -ne 'cn') {
		try { Invoke-WebRequest -Uri $registry -TimeoutSec 6 -UseBasicParsing | Out-Null; $reachable = $true }
		catch { if ($_.Exception.Response) { $reachable = $true } }
	}
	if ($reachable) {
		Write-Host '下载预构建的后端镜像（约 550 MB，第一次通常 1–5 分钟）…'
		& docker compose --env-file $EnvFile pull n8n
		if ($LASTEXITCODE -eq 0) { return }
		Write-Host '预构建镜像下载失败，改为在本机构建。'
	}
	Select-Mirrors
	Write-Host '在本机构建后端（第一次约 10 分钟）…'
	if ($PullBase) { Invoke-Compose build --pull n8n } else { Invoke-Compose build n8n }
}

function Wait-Ready {
	$url = "http://127.0.0.1:$(Get-Port)/webhook/obsidian-video-summary"
	$headers = @{ 'X-Video-Summary-Token' = (Get-EnvValue 'VS_WEBHOOK_TOKEN') }
	$deadline = (Get-Date).AddMinutes(10)
	Write-Host -NoNewline '等待后端就绪'
	while ((Get-Date) -lt $deadline) {
		try {
			Invoke-WebRequest -Uri $url -Method Post -Headers $headers -ContentType 'application/json' `
				-Body '{"name":"test","metadata":{}}' -TimeoutSec 10 -UseBasicParsing | Out-Null
			Write-Host ' 好了。'
			return
		} catch {
			Write-Host -NoNewline '.'
			Start-Sleep -Seconds 3
		}
	}
	Write-Host ''
	Fail '等了 10 分钟后端还没就绪。运行 .\vs-backend.ps1 logs 看日志。'
}

function Show-Code {
	$code = Get-ConnectionCode
	Write-Host ''
	Write-Host '连接码（在 Obsidian → 设置 → 视频总结 → 首次配置 里粘贴）：'
	Write-Host ''
	Write-Host "  $code" -ForegroundColor Cyan
	Write-Host ''
	try { Set-Clipboard -Value $code; Write-Host '已复制到剪贴板。' } catch { }
	Write-Host '这串连接码相当于后端的口令，不要发给别人。'
}

switch ($Command) {
	'start' {
		Test-Docker
		Initialize-Env
		Read-Keys
		Select-Port
		& docker image inspect (Get-ImageRef) *> $null
		if ($LASTEXITCODE -ne 0) { Get-Image }
		Write-Host '启动后端…'
		Invoke-Compose up -d --no-build
		Wait-Ready
		Show-Code
	}
	'code' { Initialize-Env; Show-Code }
	'check' { Invoke-Compose exec -T n8n node /opt/video-summary/init/check.mjs }
	'keys' { Test-Docker; Initialize-Env; Read-Keys -Force; Invoke-Compose up -d; Wait-Ready }
	'logs' { & docker compose --env-file $EnvFile logs -f --tail 100 n8n }
	'stop' { Invoke-Compose stop }
	'update' { Test-Docker; Initialize-Env; Get-Image -PullBase; Invoke-Compose up -d --no-build; Wait-Ready; Show-Code }
	default { Fail "不认识的命令：$Command（可用：start code check keys logs stop update）" }
}
