export {
  CONFIG_ENV_VAR,
  CollectorConfigError,
  DEFAULT_CONFIG_PATH,
  DEFAULT_GLOB,
  DEFAULT_STATE_FILE,
  defaultSources,
  loadCollectorConfig,
  parseCollectorConfig,
  readToken,
  resolveCollectorConfigPath,
  type CollectorConfig,
  type CollectorConfigInput,
  type ConfigEnvironment,
  type SourceConfig,
} from "./config.ts";
export { COLLECTOR_VERSION, buildHeartbeat, type SourceStats } from "./heartbeat.ts";
export { createCollector, type Collector, type CollectorOptions, type ScanResult } from "./main.ts";
export { findEligibleEnd, listSourceFiles, resumePoint, type Logger, type SourceFile } from "./scanner.ts";
export { STATE_VERSION, StateStore, stateKey, type FileState } from "./state.ts";
export { Backoff, Uploader, encodeIngestPath, type AppendOutcome, type AppendRequest } from "./uploader.ts";
