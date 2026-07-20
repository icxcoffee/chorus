# Worker Architecture

All workers update one process-global in-memory map. Deployments run multiple processes, but no durable or shared coordination mechanism is defined.
