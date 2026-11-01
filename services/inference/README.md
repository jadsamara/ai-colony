# Inference boundary

Milestone 3 calls models through `@ai-colony/inference`, an OpenAI-compatible HTTP client. This directory is still not a model server and it does not download weights.

Point `INFERENCE_BASE_URL` at a local Ollama server, by default `http://127.0.0.1:11434`, and set `INFERENCE_MODEL_ALIAS` to the id from `/v1/models`. The control plane probes that endpoint before it records a runtime status of `ready`. Registry metadata alone does not make a model ready.

The Python training and inference workers described in Milestone 1 are still not implemented here.
