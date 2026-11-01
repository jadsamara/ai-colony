# Training worker

This directory is reserved for a future Python training worker using PyTorch and PEFT. Milestone 1 does not implement it.

The control plane can store a `trainable` flag and parameter budgets as metadata. Those fields do not start a job, allocate a GPU, or update weights.

A later worker can implement `TrainingWorkerPort` in `packages/core/src/runtime/worker-ports.ts`. That interface has no implementation. The agent runtime never calls it.

Expected future responsibilities, not built here:

- accept an approved training specification that names a registry model and adapter version
- write a new adapter version without overwriting earlier versions
- report metrics back to the control plane for a separate evaluation step

Do not add a fake training loop or a checkpoint writer in this milestone.
