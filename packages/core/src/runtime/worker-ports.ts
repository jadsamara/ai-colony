/**
 * Future inference worker. Milestone 1 does not implement this port.
 * The agent runtime must not call it or report inference as available.
 */
export interface InferenceWorkerPort {
  readonly implemented: false;
  health(): Promise<{ ready: false; reason: "not-implemented" }>;
}

/**
 * Future training worker. Milestone 1 does not implement this port.
 * No training job, adapter, or weight update is performed.
 */
export interface TrainingWorkerPort {
  readonly implemented: false;
  health(): Promise<{ ready: false; reason: "not-implemented" }>;
}
