# M12 GCP deployment guide

This guide describes how the dedicated department serving plan would be deployed later. Nothing in this milestone creates a GCP resource, a GPU, a Secret Manager secret, or a running model server.

## What is implemented

- One serving-instance identity and one endpoint reference per active department.
- A trusted endpoint directory. Tasks cannot supply a URL.
- Container-shaped service records from `gcpDeploymentPlan`.
- `infra/gcp/m12/main.tf`, with `enable_paid_resources` defaulting to false. `terraform apply` is not part of this milestone.

## What an operator would do later

1. Choose Compute Engine GPU VMs that can hold one or more dedicated serving processes. Do not assume one GPU per department, and do not assume twelve Qwen3-8B processes fit on one device.
2. Build two images per department: the department agent process and its model-serving process. Store them in Artifact Registry.
3. Give each department its own service account. Grant that account only its model artifact, its secret, and its log writer role.
4. Put the serving URL in Secret Manager. The colony resolves `serving://<slug>` from that trusted config.
5. Run the serving process and the agent process as separate containers. Do not point two departments at one Ollama daemon.
6. Send logs to Cloud Logging and health to Cloud Monitoring. Keep the network private and authenticated.
7. Leave `enable_paid_resources` false until that change is reviewed. Then set it in an environment-specific tfvars file, not in the default.

## Not done

No project was selected, no API was enabled, and no VM, disk, address, or secret was created.
