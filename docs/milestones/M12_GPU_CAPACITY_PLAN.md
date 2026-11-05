# M12 GPU capacity plan

These figures are estimates from `estimateDedicatedCapacity`. This milestone did not load twelve Qwen processes and did not measure GPU memory.

| Item | Value | Kind |
| --- | --- | --- |
| Instances | 12, one dedicated process per active department | Plan |
| Weight memory per instance | about 5.2 GB | Estimate, not a load measurement |
| Aggregate weights | about 62.4 GB | Estimate |
| KV cache per modest request | about 512 MB | Estimate |
| Serving overhead per process | about 1.5 GB | Estimate |
| Resident total, one request each | about 87 GB before fragmentation | Estimate |
| 24 GB unified memory | Does not fit | Estimate |
| Memory pooled across GPUs | Not assumed | Constraint |

A host may run more than one department process when its own memory can hold those processes. A model does not spill onto a second GPU unless the deployment explicitly uses model parallelism.

Startup time, fragmentation, and concurrency were not measured. A later deployment should measure one process, then add processes until the host's free memory is gone, and only then add another VM.
