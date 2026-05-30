#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/QQ1000COM/ChatGPT2API-1.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/chatgpt2api}"
APP_PORT="${APP_PORT:-3000}"
AUTH_KEY="${CHATGPT2API_AUTH_KEY:-}"
BASE_URL="${CHATGPT2API_BASE_URL:-}"
STORAGE_BACKEND="${STORAGE_BACKEND:-json}"
DATABASE_URL="${DATABASE_URL:-}"
GIT_REPO_URL="${GIT_REPO_URL:-}"
GIT_TOKEN="${GIT_TOKEN:-}"
GIT_BRANCH="${GIT_BRANCH:-main}"
GIT_FILE_PATH="${GIT_FILE_PATH:-accounts.json}"
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-0}"
BACKUP_DIR="${BACKUP_DIR:-/opt/chatgpt2api-backups}"
ROLLBACK="${ROLLBACK:-0}"
STATUS_ONLY="${STATUS_ONLY:-0}"

usage() {
  cat <<'EOF'
ChatGPT2API one-click installer/upgrader

Usage:
  bash scripts/install.sh --auth-key <key> [options]
  curl -fsSL <raw-install-url> | bash -s -- --auth-key <key> [options]

Options:
  --repo <url>            Git repository URL. Default: https://github.com/QQ1000COM/ChatGPT2API-1.git
  --branch <name>         Git branch. Default: main
  --dir <path>            Install directory. Default: /opt/chatgpt2api
  --port <port>           Host port mapped to container port 80. Default: 3000
  --auth-key <key>        Admin/API key. Required on first install.
  --base-url <url>        Public base URL, for generated image URLs.
  --storage <backend>     json, sqlite, postgres, or git. Default: json
  --database-url <url>    DATABASE_URL for sqlite/postgres storage.
  --skip-docker-install   Do not install Docker automatically.
  --rollback              Restore the latest installer backup and restart.
  --status                Show container status and recent logs, then exit.
  -h, --help              Show this help.

Environment variables with the same names are also supported.
EOF
}

log() {
  printf '\033[1;34m[chatgpt2api]\033[0m %s\n' "$*"
}

die() {
  printf '\033[1;31m[chatgpt2api]\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --port) APP_PORT="${2:-}"; shift 2 ;;
    --auth-key) AUTH_KEY="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --storage) STORAGE_BACKEND="${2:-}"; shift 2 ;;
    --database-url) DATABASE_URL="${2:-}"; shift 2 ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$REPO_URL" ]] || die "--repo is required"
[[ -n "$BRANCH" ]] || die "--branch is required"
[[ -n "$INSTALL_DIR" ]] || die "--dir is required"
[[ -n "$APP_PORT" ]] || die "--port is required"

if [[ "$(uname -s)" != "Linux" ]]; then
  die "This installer is intended for Linux servers."
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

run_as_root() {
  if [[ -n "$SUDO" ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

install_packages() {
  local packages=("$@")
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y "${packages[@]}"
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add --no-cache "${packages[@]}"
  else
    die "Unsupported Linux distribution. Please install: ${packages[*]}"
  fi
}

ensure_git_curl() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=("git")
  command -v curl >/dev/null 2>&1 || missing+=("curl")
  if [[ "${#missing[@]}" -gt 0 ]]; then
    log "Installing required packages: ${missing[*]}"
    install_packages "${missing[@]}"
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi
  [[ "$SKIP_DOCKER_INSTALL" != "1" ]] || die "Docker or docker compose is missing."
  log "Installing Docker Engine and Compose plugin"
  curl -fsSL https://get.docker.com | sh
  if [[ -n "$SUDO" ]]; then
    sudo usermod -aG docker "$USER" || true
  fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die "docker compose is not available"
  fi
}

status_report() {
  cd "$INSTALL_DIR"
  compose -f docker-compose.deploy.yml ps || true
  compose -f docker-compose.deploy.yml logs --tail=80 app || true
}

backup_current() {
  [[ -d "$INSTALL_DIR" ]] || return 0
  run_as_root mkdir -p "$BACKUP_DIR"
  local name="chatgpt2api-$(date +%Y%m%d-%H%M%S).tgz"
  log "Creating upgrade backup: $BACKUP_DIR/$name"
  tar -C "$(dirname "$INSTALL_DIR")" \
    --exclude='chatgpt2api/.git' \
    --exclude='chatgpt2api/web/node_modules' \
    --exclude='chatgpt2api/web/.next' \
    -czf "$BACKUP_DIR/$name" "$(basename "$INSTALL_DIR")"
}

rollback_latest() {
  local latest
  latest="$(ls -1t "$BACKUP_DIR"/chatgpt2api-*.tgz 2>/dev/null | head -n 1 || true)"
  [[ -n "$latest" ]] || die "No backup found in $BACKUP_DIR"
  log "Rolling back from $latest"
  if [[ -d "$INSTALL_DIR" ]]; then
    cd "$INSTALL_DIR"
    compose -f docker-compose.deploy.yml down || true
  fi
  tar -xzf "$latest" -C "$(dirname "$INSTALL_DIR")"
  cd "$INSTALL_DIR"
  compose -f docker-compose.deploy.yml up -d --build
  verify
}

check_port() {
  if command -v ss >/dev/null 2>&1 && ss -lnt "( sport = :$APP_PORT )" | tail -n +2 | grep -q .; then
    if ! curl -fsS "http://127.0.0.1:${APP_PORT}/docs" >/dev/null 2>&1; then
      die "Port $APP_PORT is already in use. Pass --port <free-port> or stop the other service."
    fi
  fi
}

prepare_source() {
  run_as_root mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Updating source in $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
  elif [[ -e "$INSTALL_DIR" ]]; then
    die "$INSTALL_DIR exists but is not a git repository. Move it away or choose --dir."
  else
    log "Cloning $REPO_URL#$BRANCH to $INSTALL_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
}

write_env() {
  cd "$INSTALL_DIR"
  mkdir -p data

  if [[ -z "$AUTH_KEY" && -f .env ]]; then
    AUTH_KEY="$(grep -E '^CHATGPT2API_AUTH_KEY=' .env | tail -n 1 | cut -d= -f2- || true)"
  fi
  [[ -n "$AUTH_KEY" ]] || die "--auth-key is required because no existing .env key was found"

  if [[ -z "$BASE_URL" ]]; then
    BASE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${APP_PORT}"
  fi

  umask 077
  cat > .env <<EOF
CHATGPT2API_AUTH_KEY=${AUTH_KEY}
CHATGPT2API_BASE_URL=${BASE_URL}
STORAGE_BACKEND=${STORAGE_BACKEND}
DATABASE_URL=${DATABASE_URL}
GIT_REPO_URL=${GIT_REPO_URL}
GIT_TOKEN=${GIT_TOKEN}
GIT_BRANCH=${GIT_BRANCH}
GIT_FILE_PATH=${GIT_FILE_PATH}
APP_PORT=${APP_PORT}
CHATGPT2API_CONTAINER=chatgpt2api
CHATGPT2API_IMAGE=chatgpt2api:deploy
EOF

  if [[ ! -f config.json ]]; then
    cat > config.json <<EOF
{
  "auth-key": "${AUTH_KEY}",
  "base-url": "${BASE_URL}"
}
EOF
  fi
}

deploy() {
  cd "$INSTALL_DIR"
  check_port
  log "Building and starting ChatGPT2API"
  compose -f docker-compose.deploy.yml up -d --build
  log "Pruning unused Docker build cache"
  docker builder prune -f >/dev/null 2>&1 || true
}

verify() {
  cd "$INSTALL_DIR"
  local url="http://127.0.0.1:${APP_PORT}/docs"
  log "Waiting for service: $url"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "Deployment completed"
      log "Web: ${BASE_URL}"
      log "API: ${BASE_URL%/}/v1"
      log "Install dir: $INSTALL_DIR"
      return
    fi
    sleep 2
  done
  compose -f docker-compose.deploy.yml logs --tail=120 app || true
  die "Service did not become healthy in time"
}

ensure_git_curl
ensure_docker
if [[ "$STATUS_ONLY" == "1" ]]; then
  status_report
  exit 0
fi
if [[ "$ROLLBACK" == "1" ]]; then
  rollback_latest
  exit 0
fi
backup_current
prepare_source
write_env
deploy
verify
