// Wire types for the dashboard API (/api/dashboard/*). Shared by the server
// and the browser app in src/web, so this file must stay type-only.

import type { ExhaustionPrediction } from "./providers/ollama/prediction.js";
import type {
  AccountStatus,
  AdminNotification,
  HealthScoreBreakdown,
  ModelTierAccess,
  RecentEvent,
  RequestLogEntry,
  RoutingModelDiagnostics,
  RoutingAccountDiagnostic,
  StatusResponse,
  UpdateInfo,
} from "./types.js";

export type { HealthScoreBreakdown };

/** Token bucket with an absolute refill time instead of a countdown. */
export interface DashboardTokenBucket {
  enabled: boolean;
  tokens: number;
  capacity: number;
  nextRefillAt: number | null;
}

export type DashboardAccount = Omit<AccountStatus, "tokenBucket"> & {
  tokenBucket: DashboardTokenBucket;
};

export type DashboardRoutingAccount = Omit<
  RoutingAccountDiagnostic,
  "tokenBucket"
> & {
  tokenBucket: DashboardTokenBucket;
};

export type DashboardRoutingDiagnostics = Omit<
  RoutingModelDiagnostics,
  "accounts"
> & {
  accounts: DashboardRoutingAccount[];
};

export type RoutingHealthState = StatusResponse["routingHealth"]["state"];

export type DashboardRoutingHealth = Omit<
  StatusResponse["routingHealth"],
  "nextRetryIn"
> & {
  nextRetryAt: number | null;
};

export interface TrafficMinute {
  start: number;
  requests: number;
  tokens: number;
}

/**
 * Everything the dashboard needs except history. Relative countdowns from
 * the rotator are converted to absolute timestamps so an idle rotator
 * produces an identical snapshot from one second to the next.
 */
export interface DashboardOverview {
  generatedAt: number;
  version: string;
  /** Catalog/configuration changes are streamed independently of traffic. */
  modelCatalogRevision?: string;
  proxyPort: number;
  startedAt: number;
  requestsPerRotation: number;
  maxConcurrentRequestsPerAccount: number;
  totalRequestsAllAccounts: number;
  activeAccounts: Record<string, string>;
  accounts: DashboardAccount[];
  protectivePause: { until: number; reason: string | null };
  operatorControls: StatusResponse["operatorControls"];
  security: StatusResponse["security"];
  routingHealth: DashboardRoutingHealth;
  routingDiagnostics: Record<string, DashboardRoutingDiagnostics>;
  modelRoutes?: StatusResponse["modelRoutes"];
  /** Breaker key -> epoch ms when it lifts. */
  circuitBreakers: {
    model: Record<string, number>;
    project: Record<string, number>;
  };
  predictions: Record<string, ExhaustionPrediction>;
  modelTierAccess: Record<string, ModelTierAccess> | null;
  updateInfo: UpdateInfo | null;
  notifications: AdminNotification[];
  hostedOAuthConfigured: boolean;
  capabilities: { database: boolean };
  usage: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    savingsUsd: number;
  };
  /** Per-minute traffic for the last hour, oldest first. */
  traffic: TrafficMinute[];
  /** Requests per display model over the last hour. */
  recentRequestsByModel: Record<string, number>;
}

export type OverviewSection = Exclude<keyof DashboardOverview, "accounts">;

export interface LiveRequest extends RequestLogEntry {
  id: number;
}

export interface LiveEvent extends RecentEvent {
  id: number;
}

export interface DashboardSnapshot {
  overview: DashboardOverview;
  /** Newest first. */
  requests: LiveRequest[];
  /** Newest first. */
  events: LiveEvent[];
}

export interface AccountsPatch {
  upsert: DashboardAccount[];
  /** Account IDs (legacy producers without id use email). */
  remove: string[];
  /** Full account-ID order, sent only when it changed. */
  order?: string[];
}

export type DashboardStreamMessage =
  | { type: "snapshot"; data: DashboardSnapshot }
  | { type: "overview"; data: Partial<Pick<DashboardOverview, OverviewSection>> }
  | { type: "accounts"; data: AccountsPatch }
  | { type: "requests"; data: LiveRequest[] }
  | { type: "events"; data: LiveEvent[] };

export const USAGE_RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface UsageModelTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface UsageBucket {
  /** Bucket start, epoch ms. */
  start: number;
  /** Bucket length in ms (minute, hour or day). */
  span: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  byModel: Record<string, UsageModelTotals>;
}

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export interface LatencySummary {
  ttfb: { p50: number; p95: number };
  total: { p50: number; p95: number };
  count: number;
}

export interface UsageResponse {
  range: UsageRange;
  generatedAt: number;
  /** Buckets inside the range window (plus a small alignment margin). */
  buckets: UsageBucket[];
  /** List prices for every model in `buckets`; unpriced models are absent. */
  pricing: Record<string, ModelPrice>;
  allTime: {
    inputTokens: number;
    outputTokens: number;
    requests: number;
    savingsUsd: number;
  };
  latency: Record<string, LatencySummary>;
}

export interface ActivityResponse {
  generatedAt: number;
  /** [hourStartMs, requests] pairs for the last 60 days, non-zero only. */
  hours: Array<[number, number]>;
}

export interface SessionInfo {
  authenticated: boolean;
  authRequired: boolean;
}

// ── Models page (/api/catalog) ──────────────────────────────────────────

export interface CatalogProvider {
  id: string;
  name: string;
  credentialKind: "oauth" | "api-key" | "web-session";
  /** False when the operator turned the provider off. */
  enabled: boolean;
}

export interface CatalogModelEntry {
  providerId: string;
  id: string;
  contextWindow: number | null;
  /** Quota row the model draws from (`account.quota[].modelKey`). */
  quotaPool: string;
  source: "catalog" | "discovered";
  /** Why the model is off: its provider, its own switch, or waiting for review. */
  offReason: "provider" | "model" | "review" | null;
  /** The model's own switch, whatever its provider's switch says. */
  modelSwitch: "on" | "off" | "review";
  /** Requests for this id go to this provider. */
  routed: boolean;
  /** Set when an effort-routed model ID sends one of its effort levels here. */
  effortRoute?: { alias: string; effort: string };
}

/** One effort level of an effort-routed model ID. */
export interface CatalogEffortTarget {
  /** Lower-cased level name, e.g. "high". */
  effort: string;
  /** Google Antigravity model the level routes to. */
  model: string;
  /** False when no provider lists the model right now. */
  known: boolean;
  /** False when a request for this level would be refused (model off or waiting for review). */
  served: boolean;
}

/**
 * live: listed in /v1/models and every level is served.
 * partial: listed, but some levels are refused.
 * hidden: not listed (default model refused or missing, or another provider owns the ID).
 * off: its own switch is off.
 * provider-off: Google Antigravity is off.
 */
export type EffortRouteStatus = "live" | "partial" | "hidden" | "off" | "provider-off";

/** A model ID clients call that picks a target from the request's effort. */
export interface CatalogEffortRoute {
  alias: string;
  defaultEffort: string;
  /** Standard levels first (minimal to max), then custom ones. */
  targets: CatalogEffortTarget[];
  /** Its own switch: off rejects every request for the ID. */
  enabled: boolean;
  /** Clients see it in /v1/models. */
  listed: boolean;
  /** Another provider lists the same ID and gets its requests instead. */
  shadowedBy: string | null;
  status: EffortRouteStatus;
}

/** Effort variants of one model family that no effort route uses yet. */
export interface CatalogEffortSuggestion {
  alias: string;
  targets: Array<{ effort: string; model: string }>;
}

export interface ModelCatalogResponse {
  ok: true;
  /** Every provider, in routing order. */
  providers: CatalogProvider[];
  /** Every provider's models, in provider order. */
  models: CatalogModelEntry[];
  /** False when models a provider adds later stay off until turned on. */
  autoEnableNewModels: boolean;
  /** Configured effort routes, in config order. */
  effortRoutes: CatalogEffortRoute[];
  /** Model families that could become effort routes. */
  effortSuggestions: CatalogEffortSuggestion[];
}

/** Body of a refused effort route change; field keys are "alias", "defaultEffort", "targets" or "targets.<level>". */
export interface EffortRouteErrorResponse {
  ok: false;
  error: string;
  fieldErrors?: Record<string, string>;
}
