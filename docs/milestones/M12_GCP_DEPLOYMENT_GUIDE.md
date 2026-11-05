# GCP deployment guide

This guide is the operator path for the dedicated department stack. No VM, disk, address, secret, or Artifact Registry image has been created. `infra/gcp/m12/main.tf` keeps `enable_paid_resources` false. Do not run `terraform apply`.

Stopping the Docker containers does not stop Compute Engine billing. Stop or delete the VM when the GPU is not in use.

## What the repository already contains

- `deploy/docker-compose.gcp.yml`: 12 agent containers and 12 private Ollama containers. No published Ollama ports. No GPU device unless that department's device id is set in the renderer.
- `deploy/docker-compose.mock.yml`: the same shape with mock inference and no GPU. This is the only stack that has been started. It does not load Qwen.
- `deploy/Dockerfile.agent` and `deploy/Dockerfile.mock`.
- `deploy/bootstrap-gcp-vm.sh` for a fresh Ubuntu GPU VM. It installs or checks Docker, Compose, the NVIDIA driver, and the NVIDIA Container Toolkit. It does not contain credentials and does not start the colony unless `COLONY_BOOTSTRAP_START=true`.
- `pnpm colony:provision` refuses real startup until `COLONY_GPU_VRAM_BYTES` or `COLONY_HOST_RAM_BYTES` can hold the estimate in `docs/milestones/M12_GPU_CAPACITY_PLAN.md`. Those capacity figures are estimates, not measurements.

## Walkthrough

1. Create a Compute Engine GPU VM whose memory can hold the processes you intend to run. Do not assume twelve Qwen3-8B processes fit on one GPU or one VM. Do not assume GPU memory pools across devices. Leave `enable_paid_resources` false in the Terraform default.
2. On that Ubuntu VM, install Docker and the NVIDIA runtime with `bash deploy/bootstrap-gcp-vm.sh`. Confirm `nvidia-smi` and `docker compose version`.
3. Build `deploy/Dockerfile.agent` on the VM, or push it to Artifact Registry from a trusted build and set `COLONY_AGENT_IMAGE` plus `COLONY_AGENT_PULL_POLICY=always`. The Ollama image pin is `ollama/ollama:0.9.6`.
4. Export `DATABASE_URL` and `RABBITMQ_URL` in the environment or from Secret Manager. Do not commit them. Copy `deploy/colony.env.example` and fill the capacity values from the machine you measured.
5. Record the approved Qwen3-8B digest in `COLONY_MODEL_DIGESTS`. Run `pnpm colony:provision`. It prepares the plan and refuses the deploy when capacity, digests, or endpoints are unsafe. It does not download weights unless `COLONY_ALLOW_MODEL_DOWNLOAD=true` and the digest is missing rather than mismatched. A mismatched volume is left as it is.
6. Run `pnpm colony:start`. Agents start with `COLONY_ACCEPT_TASKS=false`, so old outbox work is not consumed.
7. Probe readiness with `pnpm colony:status` and `pnpm colony:routing:activate`. Activation writes `deploy/state/dedicated-routing.json` only when every department endpoint answers. Then restart the workers with `COLONY_DEDICATED_ROUTING=on`. A registry row marked `ready` is not itself a probe.
8. Submit an objective only after you set `COLONY_ACCEPT_TASKS=true`. Until that variable is set on the Compose project, workers heartbeat and do not take tasks.
9. Stop the containers with `pnpm colony:stop`. Volumes and the database are kept.
10. Stop the VM in Compute Engine. Container shutdown does not end GPU charges.
11. Start the VM again later. Docker is enabled on boot, and the Compose services use `restart: unless-stopped`. Run `pnpm colony:status` and activate dedicated routing again if the probes are green. Pinned tasks keep their original serving instance and model version. They are not moved to a new model silently.

## Isolation

Each department container may call only `ollama-<slug>` or `mock-<slug>`. Dedicated routing, once activated, will not send a failed department to another department's Ollama or to the legacy shared server. Endpoint references stay `serving://<slug>` and resolve through that Compose DNS name or an operator directory, not through a task payload.

## Security

Use one service account per department when you move this to IAM. Grant that account its own model artifact, its own secret, and a log writer role. Put the serving URL in Secret Manager. Do not store database passwords, GitHub tokens, or GCP keys in this repository. The Compose network does not publish the model ports.
