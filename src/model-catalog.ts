// Which provider serves a model, and which providers and models the operator
// turned off on the dashboard's Models page.
//
// Every provider lists the models it serves (ProviderAdapter.listModels). When
// more than one provider lists the same id, `providerOrder` decides which one
// gets the request. Ids no provider lists (aliases, upstream names, ids a
// provider claims by pattern) keep the fixed ownership checks in
// providers/registry.ts, so routing for them is unchanged.

import type { Config } from "./types.js";
import { applyModelAlias, getEffortRoutingRule } from "./types.js";
import type { ProviderModel } from "./providers/adapter.js";
import {
  findProviderForModel,
  getProviderAdapter,
  isKnownProvider,
} from "./providers/registry.js";

/**
 * Priority for ids more than one provider lists, before the operator changes
 * it. Matches the historical ownership order in findProviderForModel, so
 * upgrading changes no routing.
 */
export const DEFAULT_PROVIDER_ORDER: readonly string[] = [
  "opencode-zen",
  "openai-codex",
  "ollama",
  "google-antigravity",
  "gemini-web",
  "chatgpt-app",
];

/** The rotator state the catalog reads. Test stubs may omit any of it. */
export interface ModelCatalogSource {
  getConfig?(): Config;
  getOllamaModels?(): string[];
  getCodexModels?(): string[];
  /** Whether an in-service account can use the provider right now. */
  hasActiveProvider?(providerId: string): boolean;
}

export type ModelOffReason = "provider" | "model" | "review";

/** The model's own switch, regardless of its provider's switch. */
export type ModelSwitch = "on" | "off" | "review";

export interface CatalogModel extends ProviderModel {
  providerId: string;
  /** Why the model is off, or null when it is served. */
  offReason: ModelOffReason | null;
  modelSwitch: ModelSwitch;
}

export type ModelRoute =
  /** Send the request to this provider. */
  | { kind: "provider"; providerId: string; modelId: string }
  /** Every provider that serves the model is turned off for it. */
  | { kind: "off"; providerIds: string[] }
  /** No provider lists the id; callers keep their own provider checks. */
  | { kind: "unlisted" };

interface ModelSettings {
  order: string[];
  disabledProviders: Set<string>;
  disabledModels: Set<string>;
  autoEnableNewModels: boolean;
  reviewedModels: Set<string>;
}

/** Config key for one provider's copy of a model: "ollama/gpt-oss:120b". */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Splits "provider/model"; model ids may themselves contain slashes. */
export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  const providerId = key.slice(0, slash);
  if (!isKnownProvider(providerId)) return null;
  return { providerId, modelId: key.slice(slash + 1) };
}

const fold = (value: string) => value.trim().toLowerCase();

/** Configured order, limited to known providers, with any missing ones appended in default order. */
export function resolveProviderOrder(order: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const id of [...(order ?? []), ...DEFAULT_PROVIDER_ORDER]) {
    if (isKnownProvider(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function readSettings(config: Partial<Config> | undefined): ModelSettings {
  return {
    order: resolveProviderOrder(config?.providerOrder),
    disabledProviders: new Set(config?.disabledProviders ?? []),
    disabledModels: new Set((config?.disabledModels ?? []).map(fold)),
    autoEnableNewModels: config?.autoEnableNewModels ?? true,
    reviewedModels: new Set((config?.reviewedModels ?? []).map(fold)),
  };
}

function modelSwitchFor(settings: ModelSettings, providerId: string, modelId: string): ModelSwitch {
  const key = fold(modelKey(providerId, modelId));
  if (settings.disabledModels.has(key)) return "off";
  if (!settings.autoEnableNewModels && !settings.reviewedModels.has(key)) return "review";
  return "on";
}

function offReasonFor(settings: ModelSettings, providerId: string, modelId: string): ModelOffReason | null {
  if (settings.disabledProviders.has(providerId)) return "provider";
  const own = modelSwitchFor(settings, providerId, modelId);
  return own === "off" ? "model" : own === "review" ? "review" : null;
}

function listFor(source: ModelCatalogSource, settings: ModelSettings): CatalogModel[] {
  const context = {
    ollamaModels: source.getOllamaModels?.() ?? [],
    codexModels: source.getCodexModels?.() ?? [],
  };
  const out: CatalogModel[] = [];
  for (const providerId of settings.order) {
    for (const model of getProviderAdapter(providerId).listModels(context)) {
      out.push({
        ...model,
        providerId,
        offReason: offReasonFor(settings, providerId, model.id),
        modelSwitch: modelSwitchFor(settings, providerId, model.id),
      });
    }
  }
  return out;
}

/** Every provider's models, in provider order, with whether each is off. */
export function listCatalogModels(source: ModelCatalogSource): CatalogModel[] {
  return listFor(source, readSettings(source.getConfig?.()));
}

/** Provider ids in routing order. */
export function getProviderOrder(source: ModelCatalogSource): string[] {
  return resolveProviderOrder(source.getConfig?.()?.providerOrder);
}

export function isProviderTurnedOff(config: Partial<Config> | undefined, providerId: string): boolean {
  return (config?.disabledProviders ?? []).includes(providerId);
}

/** Whether one provider's copy of a model may be listed and served. */
export function isModelServed(source: ModelCatalogSource, providerId: string, modelId: string): boolean {
  return offReasonFor(readSettings(source.getConfig?.()), providerId, modelId) === null;
}

/**
 * Decide which provider serves a requested model id.
 *
 * Exact ids a provider lists win. When several providers list it, the first
 * one in provider order that is on and has a usable account gets it; if none
 * has an account, the first one that is on still gets it so the request fails
 * the usual way ("no account available") instead of with a different error.
 */
export function resolveModelRoute(source: ModelCatalogSource, model: string): ModelRoute {
  const settings = readSettings(source.getConfig?.());
  const catalog = listFor(source, settings);
  const lookup = (id: string) => {
    const wanted = fold(id);
    return catalog.filter((entry) => fold(entry.id) === wanted);
  };

  let listed = lookup(model);
  if (listed.length === 0) {
    // Operator-facing aliases ("gpt-oss-120b") stand for a listed upstream id.
    const alias = applyModelAlias(model);
    if (fold(alias) !== fold(model)) listed = lookup(alias);
  }

  if (listed.length === 0) {
    // Effort aliases always dispatch to Antigravity, whatever their name looks like.
    const ownerId =
      findProviderForModel(model, {
        ollamaModels: new Set(source.getOllamaModels?.() ?? []),
        codexModels: new Set(source.getCodexModels?.() ?? []),
      })?.id ?? (getEffortRoutingRule(model) ? "google-antigravity" : null);
    if (ownerId && isTurnedOff(settings, catalog, ownerId, model)) {
      return { kind: "off", providerIds: [ownerId] };
    }
    return { kind: "unlisted" };
  }

  const on = listed.filter((entry) => entry.offReason === null);
  if (on.length === 0) {
    return { kind: "off", providerIds: [...new Set(listed.map((entry) => entry.providerId))] };
  }
  const chosen = on.find((entry) => source.hasActiveProvider?.(entry.providerId) ?? true) ?? on[0];
  return { kind: "provider", providerId: chosen.providerId, modelId: chosen.id };
}

/**
 * Whether `providerId` may not serve `model`: the provider is off, the model's
 * key is turned off, or the provider lists it and it waits for review. Unlisted
 * ids are checked against explicit keys only, since review applies to listed
 * models.
 */
function isTurnedOff(settings: ModelSettings, catalog: CatalogModel[], providerId: string, model: string): boolean {
  if (settings.disabledProviders.has(providerId)) return true;
  const wanted = fold(model);
  const listed = catalog.find((entry) => entry.providerId === providerId && fold(entry.id) === wanted);
  if (listed) return listed.offReason !== null;
  return settings.disabledModels.has(fold(modelKey(providerId, model)));
}

/** The parts of a request the switches are checked against. */
export interface RequestModels {
  /** Id sent upstream (after aliasing). */
  model: string;
  /** Concrete model or effort alias requested before target selection. */
  requestedModel?: string;
  /** Catalog id the request resolved to before upstream aliasing, if different. */
  catalogModel?: string;
  /** Provider already chosen for the request. */
  providerId?: string;
}

/**
 * Whether a request about to be sent targets a model or provider that is
 * turned off. Checks the requested id, selected catalog id, and upstream id
 * (plus their upstream aliases), against the pinned provider when there is
 * one and against routing otherwise.
 */
export function isRequestOff(source: ModelCatalogSource, request: RequestModels): boolean {
  const ids = new Set<string>();
  for (const id of [request.requestedModel, request.catalogModel, request.model]) {
    if (!id) continue;
    ids.add(id);
    ids.add(applyModelAlias(id));
  }
  if (request.providerId) {
    const settings = readSettings(source.getConfig?.());
    const catalog = listFor(source, settings);
    return [...ids].some((id) => isTurnedOff(settings, catalog, request.providerId!, id));
  }
  return [...ids].some((id) => resolveModelRoute(source, id).kind === "off");
}

/** Whether one provider may send this model upstream (benchmarks, kickstarts). */
export function isProviderModelOff(source: ModelCatalogSource, providerId: string, model: string): boolean {
  return isRequestOff(source, { model, providerId });
}

/** Provider that serves a model, or null to fall back to the caller's own checks. */
export function routedProviderId(source: ModelCatalogSource, model: string): string | null {
  const route = resolveModelRoute(source, model);
  return route.kind === "provider" ? route.providerId : null;
}

/** Client-facing explanation for a request to a model that is turned off. */
export function modelOffMessage(model: string): string {
  return `The model '${model}' is turned off on this rotator. Turn it back on from the dashboard's Models page.`;
}

// ── Settings updates ─────────────────────────────────────────────────────
// Each returns only the config fields it changes.

type ModelConfigPatch = Pick<
  Config,
  "providerOrder" | "disabledProviders" | "disabledModels" | "autoEnableNewModels" | "reviewedModels"
>;

export function setProviderTurnedOff(config: Config, providerId: string, off: boolean): Partial<ModelConfigPatch> {
  const rest = (config.disabledProviders ?? []).filter((id) => id !== providerId);
  return { disabledProviders: off ? [...rest, providerId] : rest };
}

export function setModelsTurnedOff(config: Config, keys: string[], off: boolean): Partial<ModelConfigPatch> {
  const folded = new Set(keys.map(fold));
  const disabled = (config.disabledModels ?? []).filter((key) => !folded.has(fold(key)));
  const patch: Partial<ModelConfigPatch> = { disabledModels: off ? [...disabled, ...keys] : disabled };
  if (config.autoEnableNewModels === false) {
    // A decision either way means the model has been reviewed.
    const reviewed = config.reviewedModels ?? [];
    const known = new Set(reviewed.map(fold));
    patch.reviewedModels = [...reviewed, ...keys.filter((key) => !known.has(fold(key)))];
  }
  return patch;
}

/**
 * Turning automatic enabling off records every model listed now as reviewed,
 * so only models found later wait for review. Turning it back on forgets the
 * list, and anything waiting is served.
 */
export function setAutoEnableNewModels(
  source: ModelCatalogSource,
  on: boolean,
): Partial<ModelConfigPatch> {
  if (on) return { autoEnableNewModels: true, reviewedModels: undefined };
  const config = source.getConfig?.();
  if (config?.autoEnableNewModels === false) return {};
  const current = listFor(source, readSettings({ ...config, autoEnableNewModels: true }));
  return {
    autoEnableNewModels: false,
    reviewedModels: current.map((entry) => modelKey(entry.providerId, entry.id)),
  };
}
