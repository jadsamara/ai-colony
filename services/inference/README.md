# Inference worker

This directory is reserved for a future Python inference worker. Milestone 1 does not implement it.

The control plane keeps model metadata in the model registry and agent lifecycle in the TypeScript runtime. Neither downloads weights, opens a model socket, nor claims that an agent is inferring.

A later worker can implement the `InferenceWorkerPort` interface in `packages/core/src/runtime/worker-ports.ts`. That port is documentation of the boundary only. No class implements it, and the Milestone 1 runtime does not call it.

Expected future responsibilities, not built here:

- load a registry model id and optional adapter version
- serve generation requests from an approved runtime
- report readiness without the control plane pretending the worker exists

Do not add a mock server that returns generated text.
