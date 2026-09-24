#!/usr/bin/env bash
# Invoked by the restricted GitHub Actions SSH key. Only the current main
# commit may be deployed; application data lives outside the source checkout.
set -Eeuo pipefail

revision="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full Git commit SHA from SSH_ORIGINAL_COMMAND" >&2
  exit 2
fi
if [[ "$(id -u)" != 0 ]]; then
  echo "Deployment must run as the dedicated root SSH command" >&2
  exit 1
fi

root=/srv/zero-one-verifier
source_dir="$root/source"
data_dir="$root/state"
compose_files=(-f deploy/production/compose.yaml -f deploy/production/compose.edge.yaml)
export VERIFIER_DATA_DIR="$data_dir"

exec 9>/run/lock/zero-one-verifier-deploy.lock
flock -w 60 9
cd "$source_dir"

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Production source checkout has local changes; refusing to overwrite them" >&2
  exit 1
fi
test -d "$data_dir"

git fetch --no-tags origin main
if [[ "$(git rev-parse FETCH_HEAD)" != "$revision" ]]; then
  echo "Requested revision is no longer the current main commit" >&2
  exit 1
fi

previous_revision="$(git rev-parse HEAD)"
if [[ "$previous_revision" == "$revision" ]]; then
  curl --fail --silent --show-error http://127.0.0.1:8180/healthz >/dev/null
  echo "Revision $revision is already deployed and healthy"
  exit 0
fi

python3 deploy/production/backup.py \
  --data-dir "$data_dir" \
  --backup-root "$root/backups"

rollback() {
  trap - ERR
  echo "Deployment failed; restoring $previous_revision" >&2
  git checkout --detach "$previous_revision" || true
  export VERIFIER_REVISION="$previous_revision"
  docker compose "${compose_files[@]}" up -d --no-build --wait --wait-timeout 240 || true
  curl --fail --silent --show-error http://127.0.0.1:8180/healthz >/dev/null || true
  exit 1
}
trap rollback ERR

git checkout --detach "$revision"
export VERIFIER_REVISION="$revision"
docker compose "${compose_files[@]}" config --quiet
docker compose "${compose_files[@]}" up -d --build --wait --wait-timeout 240
curl --fail --silent --show-error http://127.0.0.1:8180/healthz >/dev/null
curl --fail --silent --show-error https://mix.01yapi.cc/healthz >/dev/null
curl --fail --silent --show-error https://mix.01yapi.cc/leaderboard >/dev/null
trap - ERR
echo "Deployed $revision and verified local and public health"
