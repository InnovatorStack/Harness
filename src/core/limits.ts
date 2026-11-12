/** Internal work budgets keep malformed input and accidental cycles from exhausting the host. */
export const dataDepthMax = 256;
export const dataNodesMax = 1_000_000;
export const dataBytesMax = 64 * 1024 * 1024;
export const setupFilesMax = 20_000;
export const setupBytesMax = 512 * 1024 * 1024;
export const importFramesMax = 4096;
export const workUnitsMax = 50_000_000;
export const requestDepthMax = 128;
export const requestOperationsMax = 20_000;
export const queuedRequestsMax = 1000;
export const requestTimeoutMs = 300_000;
export const traceEventsMax = 100_000;
export const traceBytesMax = 64 * 1024 * 1024;
