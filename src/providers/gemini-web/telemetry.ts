import { isRecord } from "../../compat/schema-sanitizer.js";

const STAGES = ["session", "sessionWait", "fileLock", "init", "modelSelection", "quota", "generation", "googleRequest", "googleHeaders", "googleFirstChunk", "googleStreamEnd", "imageDownload", "persist"];
const ERROR_KINDS = ["unknown", "WorkerError", "GoogleStreamError", "ModelVerificationError", "AuthError",
  "UsageLimitExceededError", "TemporarilyBlockedError", "ModelInvalidError", "APIError", "TimeoutError",
  "CancelledError", "ConnectionError", "OSError", "CurlError", "ImportError", "ModuleNotFoundError"];

/** Rebuild the private worker event from fixed keys; never log the event itself. */
export function workerTelemetry(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  const integer = (value: unknown, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const timings: Record<string, number> = {};
  if (isRecord(value.timingsMs)) for (const stage of STAGES) {
    const ms = value.timingsMs[stage];
    if (integer(ms, 3600000)) timings[stage] = ms;
  }
  result.timingsMs = timings;
  for (const key of ["sessionMs", "attempts", "googleRequests", "googleCode"]) {
    const number = value[key];
    if (integer(number, key === "googleCode" ? 99999999 : key === "sessionMs" ? 3600000 : 100)) result[key] = number;
  }
  if (typeof value.errorKind === "string" && ERROR_KINDS.includes(value.errorKind)) result.errorKind = value.errorKind;
  if (typeof value.failedStage === "string" && STAGES.includes(value.failedStage)) result.failedStage = value.failedStage;
  return result;
}
