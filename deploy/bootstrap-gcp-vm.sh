#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu GPU VM for the dedicated colony.
# This script does not create a VM, does not call terraform apply,
# and does not start the colony unless COLONY_BOOTSTRAP_START=true.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This bootstrap is for an Ubuntu GPU VM. It does not run on the developer machine."
  exit 1
fi
if ! grep -qi ubuntu /etc/os-release; then
  echo "Refusing to bootstrap: /etc/os-release is not Ubuntu."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker version >/dev/null
docker compose version >/dev/null
sudo systemctl enable docker

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA driver is not installed. Install the driver that matches this GPU before loading models."
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total --format=csv

if ! dpkg -s nvidia-container-toolkit >/dev/null 2>&1; then
  sudo curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  distribution=$(. /etc/os-release && echo "$ID$VERSION_ID")
  sudo curl -fsSL "https://nvidia.github.io/libnvidia-container/${distribution}/libnvidia-container.list" | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
fi

sudo mkdir -p /var/lib/colony/models /var/lib/colony/state
sudo chown "$(id -u)":"$(id -g)" /var/lib/colony/models /var/lib/colony/state

if [[ -z "${DATABASE_URL:-}" || -z "${RABBITMQ_URL:-}" ]]; then
  echo "DATABASE_URL and RABBITMQ_URL must be set in the environment. This script does not contain credentials."
  exit 1
fi

if [[ "${COLONY_BOOTSTRAP_START:-false}" != "true" ]]; then
  echo "Docker and the NVIDIA runtime are ready. The colony was not started."
  echo "Set COLONY_BOOTSTRAP_START=true after provision succeeds, then run pnpm colony:start."
  exit 0
fi

echo "COLONY_BOOTSTRAP_START is set. Run pnpm colony:provision && pnpm colony:start from the repository."
exit 0
