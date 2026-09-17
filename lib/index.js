import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createHash } from "node:crypto";
//#region lib/types/optimizer/groups.js
/** Names that must never be deferred: the bridge and management tools. */
const FORCED_EAGER = [
	"tool_search",
	"tool_describe",
	"tool_call",
	"tool_slimmer_catalog",
	"tool_slimmer_update_config",
	"skill"
];
/**
* Resolve the group a tool belongs to: first exact-name match, then first
* prefix match, in declaration order.
* @param toolName - the registered tool name.
* @param groups - the configured groups (may be empty).
* @returns the owning group name, or `undefined` when ungrouped.
*/
function groupFor(toolName, groups) {
	for (const group of groups) {
		if (group.tools?.includes(toolName)) return group.name;
		if (group.prefixes?.some((prefix) => toolName.startsWith(prefix))) return group.name;
	}
}
/**
* Validate group declarations. Returns a human-readable reason when invalid,
* or `undefined` when the groups are usable.
* @param groups - the candidate groups from config or the update tool.
* @returns an error message, or `undefined` when valid.
*/
function validateGroups(groups) {
	const names = /* @__PURE__ */ new Set();
	for (const group of groups) {
		if (typeof group.name !== "string" || group.name.trim() === "") return "every group needs a non-empty name";
		if (names.has(group.name)) return `duplicate group name "${group.name}"`;
		names.add(group.name);
		const tools = group.tools ?? [];
		const prefixes = group.prefixes ?? [];
		if (tools.length === 0 && prefixes.length === 0) return `group "${group.name}" lists no tools or prefixes`;
		for (const tool of tools) if (typeof tool !== "string" || tool.trim() === "") return `group "${group.name}" contains an empty tool name`;
		for (const prefix of prefixes) if (typeof prefix !== "string" || prefix.trim() === "") return `group "${group.name}" contains an empty prefix`;
	}
}
/** Stable key used to name the group a tool belongs to; `null` when ungrouped. */
function groupKey(entry) {
	return entry.group ?? null;
}
/**
* Render a grouped manifest of deferred tools for the model. Full mode is
* "group / name - description"; names mode is "group / name" only.
* @param entries - the deferred catalog rows (grouped already resolved).
* @param mode - `full` includes descriptions, `names` lists names only.
* @returns the manifest text, or an empty string for an empty catalog.
*/
function buildGroupedManifest(entries, mode) {
	const byGroup = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const key = groupKey(entry) ?? "ungrouped";
		const bucket = byGroup.get(key);
		if (bucket === void 0) byGroup.set(key, [entry]);
		else bucket.push(entry);
	}
	const lines = [];
	for (const [group, members] of byGroup) {
		lines.push(`## ${group}`);
		for (const entry of members) lines.push(mode === "full" ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`);
	}
	return lines.join("\n");
}
/**
* Render the tier-3 fallback: one summary line per group plus ungrouped.
* @param entries - the deferred catalog rows.
* @returns one line per group ("group name: N tools"), or an empty string.
*/
function buildGroupSummary(entries) {
	const counts = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const key = groupKey(entry) ?? "ungrouped";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].map(([group, count]) => `- ${group}: ${count} tool${count === 1 ? "" : "s"}`).join("\n");
}
//#endregion
//#region lib/types/optimizer/config.js
/** Runtime settings owned by the unified plugin. */
const RUNTIME_FILE = "dsh-context-optimizer.json";
/**
* Resolve the harness home: `$DSH_HOME` when set (tilde-expanded), else
* `~/.dsh`. Local mirror of the harness `resolveDshHome` so the plugin needs
* no extra peer dependency.
* @returns the absolute harness home directory.
*/
function resolveDshHome() {
	const env = process.env.DSH_HOME;
	if (env !== void 0 && env !== "") return env.startsWith("~") ? join(homedir(), env.slice(1)) : resolve(env);
	return join(homedir(), ".dsh");
}
/** Absolute path of the user-global runtime config file. */
function userConfigPath() {
	return join(resolveDshHome(), RUNTIME_FILE);
}
/** Absolute path of a project-level runtime config file. */
function projectConfigPath(cwd) {
	return join(cwd, ".dsh", RUNTIME_FILE);
}
z.object({
	enabled: z.union([
		z.const("auto"),
		z.const("on"),
		z.const("off")
	]).default("auto"),
	thresholdPct: z.number().default(5).min(1).max(100),
	listingMaxTokens: z.number().default(4e3).min(100),
	contextWindow: z.number().default(128e3).min(1e3),
	searchDefaultLimit: z.number().default(5).min(1),
	maxSearchLimit: z.number().default(20).min(1),
	minCatalogSize: z.number().default(12).min(0),
	configScope: z.union([
		z.const("user"),
		z.const("project"),
		z.const("auto")
	]).default("auto"),
	core: z.array(z.string()).default(["todo_write"]),
	matcherTimeoutMs: z.number().default(15e3).min(1e3),
	maxWarmTools: z.number().default(8).min(0)
});
/**
* Parse and shape-validate a runtime config file. Throws with the offending
* path and a concrete reason so a malformed file is never silently ignored.
* @param text - the raw file text.
* @param path - the file path, used in diagnostics.
* @returns the validated runtime config.
*/
function parseRuntimeFile(text, path) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`dsh-context-optimizer: malformed runtime config ${path}: not valid JSON`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`dsh-context-optimizer: malformed runtime config ${path}: expected a JSON object`);
	const record = raw;
	const config = {};
	if (record.version !== void 0) {
		if (typeof record.version !== "number") throw new Error(`dsh-context-optimizer: ${path}: "version" must be a number`);
		config.version = record.version;
	}
	if (record.scope !== void 0) {
		if (record.scope !== "user" && record.scope !== "project") throw new Error(`dsh-context-optimizer: ${path}: "scope" must be "user" or "project"`);
		config.scope = record.scope;
	}
	if (record.groups !== void 0) {
		if (!Array.isArray(record.groups)) throw new Error(`dsh-context-optimizer: ${path}: "groups" must be an array`);
		const groups = record.groups.map((entry) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`dsh-context-optimizer: ${path}: each group must be an object`);
			const group = entry;
			if (typeof group.name !== "string") throw new Error(`dsh-context-optimizer: ${path}: each group needs a string "name"`);
			const tools = arrayOfStrings$1(group.tools, `${path}: group "${group.name}" "tools"`);
			const prefixes = arrayOfStrings$1(group.prefixes, `${path}: group "${group.name}" "prefixes"`);
			return {
				name: group.name,
				...tools !== void 0 ? { tools } : {},
				...prefixes !== void 0 ? { prefixes } : {}
			};
		});
		const reason = validateGroups(groups);
		if (reason !== void 0) throw new Error(`dsh-context-optimizer: ${path}: invalid groups: ${reason}`);
		config.groups = groups;
	}
	if (record.matcher !== void 0) {
		if (record.matcher === null || typeof record.matcher !== "object" || Array.isArray(record.matcher)) throw new Error(`dsh-context-optimizer: ${path}: "matcher" must be an object`);
		const matcher = record.matcher;
		for (const key of [
			"endpoint",
			"apiKey",
			"model"
		]) if (typeof matcher[key] !== "string" || matcher[key] === "") throw new Error(`dsh-context-optimizer: ${path}: matcher "${key}" must be a non-empty string`);
		const topN = matcher.topN;
		if (topN !== void 0 && (typeof topN !== "number" || !Number.isInteger(topN) || topN <= 0)) throw new Error(`dsh-context-optimizer: ${path}: matcher "topN" must be a positive integer`);
		config.matcher = {
			endpoint: matcher.endpoint,
			apiKey: matcher.apiKey,
			model: matcher.model,
			...topN !== void 0 ? { topN } : {}
		};
	}
	if (record.preload !== void 0) {
		if (record.preload === null || typeof record.preload !== "object" || Array.isArray(record.preload)) throw new Error(`dsh-context-optimizer: ${path}: "preload" must be an object`);
		const preload = record.preload;
		if (typeof preload.enabled !== "boolean") throw new Error(`dsh-context-optimizer: ${path}: preload "enabled" must be a boolean`);
		if (typeof preload.topK !== "number" || !Number.isInteger(preload.topK) || preload.topK <= 0) throw new Error(`dsh-context-optimizer: ${path}: preload "topK" must be a positive integer`);
		config.preload = {
			enabled: preload.enabled,
			topK: preload.topK
		};
	}
	if (record.core !== void 0) {
		const core = arrayOfStrings$1(record.core, `${path}: "core"`);
		if (core !== void 0) config.core = core;
	}
	return config;
}
function arrayOfStrings$1(value, where) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`dsh-context-optimizer: ${where} must be an array of strings`);
	return value;
}
function isNodeError(error) {
	return error instanceof Error && "code" in error;
}
/**
* Reads and caches runtime config files with mtime-based invalidation. A
* missing file resolves to `undefined`; a malformed file logs a warning and
* is treated as absent so a broken user file cannot break sessions.
*/
var RuntimeConfigStore = class {
	cache = /* @__PURE__ */ new Map();
	warn;
	constructor(warn) {
		this.warn = warn;
	}
	/** Absolute path of the user-global config file. */
	userPath() {
		return userConfigPath();
	}
	/** Absolute path of the project config file for a workspace. */
	projectPath(cwd) {
		return projectConfigPath(cwd);
	}
	/**
	* Resolve the effective runtime config for a workspace.
	* @param configScope - `user` (global only), `project` (project only, user
	*   fallback when absent), or `auto` (project when present, else user).
	* @param cwd - the session workspace, required for project resolution.
	* @returns the effective config, its scope, and the file path it came from.
	*/
	async resolve(configScope, cwd) {
		const user = await this.read(this.userPath());
		if (configScope === "user") return {
			config: user ?? {},
			scope: "user",
			path: this.userPath()
		};
		if (cwd !== void 0) {
			const project = await this.read(this.projectPath(cwd));
			if (project !== void 0) return {
				config: project,
				scope: "project",
				path: this.projectPath(cwd)
			};
			if (configScope === "project") this.warn(`dsh-context-optimizer: no project config at ${this.projectPath(cwd)}; falling back to the user config`);
		} else if (configScope === "project") this.warn("dsh-context-optimizer: configScope \"project\" but the session has no workspace; falling back to the user config");
		return {
			config: user ?? {},
			scope: "user",
			path: this.userPath()
		};
	}
	/**
	* Persist a runtime config file and invalidate its cache entry.
	* @param scope - where to write (`project` requires a workspace).
	* @param cwd - the session workspace for project writes.
	* @param data - the config to persist (version/scope stamped by the caller).
	* @returns the absolute path written.
	*/
	async write(scope, cwd, data) {
		if (scope === "project" && cwd === void 0) throw new Error("dsh-context-optimizer: cannot write a project config without a workspace (cwd)");
		const path = scope === "project" ? this.projectPath(cwd) : this.userPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify({
			version: 1,
			scope,
			...data
		}, null, 2)}\n`, "utf8");
		this.cache.delete(path);
		return path;
	}
	/** Drop all cached reads (used by tests and by the update tool). */
	invalidateAll() {
		this.cache.clear();
	}
	async read(path) {
		try {
			const meta = await stat(path);
			const cached = this.cache.get(path);
			if (cached !== void 0 && cached.mtimeMs === meta.mtimeMs) return cached.data;
			const data = parseRuntimeFile(await readFile(path, "utf8"), path);
			this.cache.set(path, {
				mtimeMs: meta.mtimeMs,
				data
			});
			return data;
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return void 0;
			this.warn(`dsh-context-optimizer: ignoring unreadable runtime config ${path}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
};
//#endregion
//#region lib/types/optimizer/catalog.js
/**
* Estimate the token cost of manifest text. Conservative upper bound: CJK
* characters at 1.5 chars/token, everything else at 4 chars/token (the same
* rule of thumb as the cx-ai TokenEstimationMiddleware).
* @param text - the manifest text to budget.
* @returns an estimated token count.
*/
function estimateTokens$1(text) {
	let cjk = 0;
	let other = 0;
	for (const char of text) if (/[\u3000-\u9fff\uf900-\ufaff]/.test(char)) cjk += 1;
	else other += 1;
	return Math.ceil(cjk / 1.5 + other / 4);
}
/**
* Snapshot the model-visible tool catalog as group-annotated rows.
* @param schemas - the registry's visible schemas (`ctx.tools.schemas(scope)`).
* @param groups - the configured groups used to annotate each tool.
* @returns catalog rows in schema order.
*/
function snapshotCatalog(schemas, groups) {
	return schemas.map((schema) => ({
		name: schema.name,
		description: schema.description ?? "",
		parameters: schema.parameters,
		group: groupFor(schema.name, groups)
	}));
}
/**
* Resolve the full schema for one catalog tool.
* @param entries - the catalog snapshot.
* @param name - the tool name to look up.
* @returns the model-facing schema fields, or `undefined` when unknown.
*/
function describeTool(entries, name) {
	const entry = entries.find((candidate) => candidate.name === name);
	if (entry === void 0) return void 0;
	return {
		name: entry.name,
		description: entry.description,
		parameters: entry.parameters
	};
}
/**
* Build the setup-facing catalog view: per-group counts plus every tool row,
* annotated with whether each tool is currently deferred (folded behind the
* bridge) so the setup skill and the model can tell registry from visibility.
* @param entries - the catalog snapshot.
* @param deferredNames - tool names currently folded; omitted marks none.
* @returns the grouped view the setup skill reads.
*/
function buildCatalogView(entries, deferredNames) {
	const counts = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const key = entry.group ?? "ungrouped";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return {
		count: entries.length,
		groups: [...counts.entries()].map(([name, count]) => ({
			name,
			count
		})),
		tools: entries.map((entry) => ({
			name: entry.name,
			description: entry.description,
			group: entry.group ?? null,
			deferred: deferredNames?.has(entry.name) ?? false
		}))
	};
}
//#endregion
//#region lib/types/optimizer/bridge.js
/** The three bridge tool names; always eager and never callable through `tool_call`. */
const BRIDGE_NAMES = [
	"tool_search",
	"tool_describe",
	"tool_call"
];
function textRender$1(_args, value) {
	return [{
		type: "text",
		text: typeof value === "string" ? value : JSON.stringify(value)
	}];
}
function errorMessage$2(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
/**
* Register the three Hermes-style bridge tools. Each returns a JSON string so
* the model can parse results directly; failures return a JSON `{ error }`
* instead of throwing, keeping the guidance model-visible.
* @param ctx - the plugin context.
* @param deps - engine-backed search/describe/dispatch services.
* @returns the combined disposer for all three registrations.
*/
function registerBridgeTools(ctx, deps) {
	const disposers = [
		ctx.tools.register(defineTool({
			name: "tool_search",
			description: "Search the deferred tool catalog (tools hidden to save tokens) and return ranked matches. Matches are injected into the visible context for later turns. Ranking uses the configured rerank matcher with a keyword fallback.",
			parameters: {
				query: {
					type: "string",
					required: true
				},
				limit: { type: "integer" }
			},
			output: {
				schema: { type: "string" },
				render: textRender$1
			},
			async execute(args, exec) {
				const { query, limit } = args;
				try {
					const outcome = await deps.search(query, limit, exec.agent);
					deps.warm(outcome.matches.map((match) => match.name), exec.agent);
					const payload = {
						matches: outcome.matches,
						mode: outcome.mode
					};
					if (outcome.hint !== void 0) payload.hint = outcome.hint;
					return JSON.stringify(payload);
				} catch (error) {
					return JSON.stringify({ error: errorMessage$2(error) });
				}
			}
		})),
		ctx.tools.register(defineTool({
			name: "tool_describe",
			description: "Load the full schema (parameters and description) of one deferred tool by name. The tool becomes visible in the context for later turns.",
			parameters: { name: {
				type: "string",
				required: true
			} },
			output: {
				schema: { type: "string" },
				render: textRender$1
			},
			async execute(args, exec) {
				const { name } = args;
				const schema = deps.describe(name, exec.agent);
				if (schema === void 0) return JSON.stringify({ error: `unknown tool "${name}"` });
				deps.warm([name], exec.agent);
				return JSON.stringify(schema);
			}
		})),
		ctx.tools.register(defineTool({
			name: "tool_call",
			description: "Invoke a deferred tool by name with its arguments. The call runs as the real tool: approvals, guards, and events use the real tool name. The tool becomes visible in the context for later turns.",
			parameters: {
				name: {
					type: "string",
					required: true
				},
				arguments: {
					type: "object",
					additionalProperties: true
				}
			},
			output: {
				schema: { type: "string" },
				render: textRender$1
			},
			async execute(args, exec) {
				const { name, arguments: toolArgs } = args;
				if (!deps.canCall(name, exec.agent)) return JSON.stringify({
					ok: false,
					error: `tool "${name}" is not callable through tool_call`
				});
				try {
					const input = {
						callId: ToolCallId(`${String(exec.callId)}:tool:${name}`),
						name,
						arguments: toolArgs ?? {},
						signal: exec.signal,
						...exec.agent !== void 0 ? { agent: exec.agent } : {}
					};
					const result = await ctx.tools.execute(input);
					deps.warm([name], exec.agent);
					if (result.isError) {
						const failure = result.error;
						const detail = failure?.message !== void 0 ? String(failure.message) : "tool call failed";
						return JSON.stringify({
							ok: false,
							error: detail
						});
					}
					return JSON.stringify({
						ok: true,
						value: result.value
					});
				} catch (error) {
					return JSON.stringify({
						ok: false,
						error: errorMessage$2(error)
					});
				}
			}
		}))
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion
//#region lib/types/optimizer/matcher.js
/**
* Call an OpenAI-compatible rerank endpoint (e.g. DashScope compatible-mode
* `qwen3-reranker`). The endpoint receives `{ model, query, documents, top_n }`
* and returns `{ results: [{ index, relevance_score }] }`.
* @param matcher - endpoint/apiKey/model and optional topN.
* @param query - the search query.
* @param documents - one text per candidate (name + description + group).
* @param timeoutMs - abort deadline for the request.
* @returns hits sorted by relevance score, highest first.
*/
async function rerank(matcher, query, documents, timeoutMs) {
	if (documents.length === 0) return [];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(matcher.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${matcher.apiKey}`
			},
			body: JSON.stringify({
				model: matcher.model,
				query,
				documents,
				...matcher.topN !== void 0 ? { top_n: matcher.topN } : {}
			}),
			signal: controller.signal
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`rerank HTTP ${response.status}: ${detail.slice(0, 300)}`);
		}
		return ((await response.json()).results ?? []).filter((result) => typeof result.index === "number").map((result) => ({
			index: result.index,
			score: result.relevance_score ?? 0
		})).sort((a, b) => b.score - a.score);
	} finally {
		clearTimeout(timer);
	}
}
/**
* Semantically search the catalog through the configured rerank matcher.
* @param matcher - the rerank configuration.
* @param query - the model's search query.
* @param entries - the deferred catalog rows.
* @param limit - how many matches to return.
* @param timeoutMs - rerank request deadline.
* @returns matches sorted by relevance, capped at `limit`.
*/
async function searchCatalog(matcher, query, entries, limit, timeoutMs) {
	if (entries.length === 0) return [];
	const hits = await rerank(matcher, query, entries.map((entry) => `${entry.group !== void 0 ? `[${entry.group}] ` : ""}${entry.name}: ${entry.description}`), timeoutMs);
	const matches = [];
	for (const hit of hits) {
		if (matches.length >= limit) break;
		const entry = entries[hit.index];
		if (entry === void 0) continue;
		matches.push({
			name: entry.name,
			description: entry.description,
			group: entry.group,
			score: hit.score
		});
	}
	return matches;
}
/**
* Keyword fallback search over the catalog: exact-name matches rank highest,
* then name substring hits, then description hits, scored per query token.
* Deterministic and dependency-free; used when no rerank matcher is
* configured or the rerank call fails, so `tool_search` never dead-ends.
* @param query - the model's search query.
* @param entries - the deferred catalog rows.
* @param limit - how many matches to return.
* @returns matches with a keyword score, sorted descending, capped at `limit`.
*/
function keywordSearch(query, entries, limit) {
	if (entries.length === 0) return [];
	const normalized = query.trim().toLowerCase();
	const tokens = normalized.split(/[^a-z0-9_]+/i).filter((token) => token.length > 0);
	const scored = [];
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		const description = entry.description.toLowerCase();
		let score = 0;
		if (name === normalized) score += 100;
		for (const token of tokens) {
			if (name.includes(token)) score += 10;
			if (description.includes(token)) score += 1;
		}
		if (score > 0) scored.push({
			entry,
			score
		});
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(({ entry, score }) => ({
		name: entry.name,
		description: entry.description,
		group: entry.group,
		score
	}));
}
//#endregion
//#region lib/types/optimizer/disclosure.js
/**
* The runtime-context name the catalog manifest rides under. Contexts survive
* the complete-prompt section replacement in `SystemPrompt.assemble`, which
* would otherwise drop a manifest appended to `sections`.
*/
const MANIFEST_CONTEXT = "tool-search:catalog";
/**
* Framing header prepended to every manifest so the model cannot mistake
* deferred tools (listed, not directly callable) for its visible set.
*/
const MANIFEST_HEADER = "Deferred tool catalog — these tools are NOT directly callable. To use one, call tool_search to find it, tool_describe to load its schema, or tool_call to invoke it. A searched, described, or called tool is injected into your visible tools for later turns.";
/**
* Decide the disclosure tier. Tier 0 keeps the surface untouched; tiers 1-3
* replace it with the bridge plus progressively cheaper listings.
* @param input - the tier inputs.
* @returns the tier for this assembly.
*/
function computeTier(input) {
	if (input.deferredSize === 0) return 0;
	if (!input.forced && input.catalogSize <= input.minCatalogSize) return 0;
	if (input.manifestTokens <= input.budget) return 1;
	if (input.namesOnlyTokens <= input.budget) return 2;
	return 3;
}
/** The listing budget: `min(thresholdPct% × contextWindow, listingMaxTokens)`. */
function budgetFor(thresholdPct, contextWindow, listingMaxTokens) {
	return Math.min(thresholdPct / 100 * contextWindow, listingMaxTokens);
}
/**
* Compute the slimmed model surface for one assembly: eager schemas plus the
* three bridge schemas, and the manifest text for the current tier.
* @param entries - the full catalog snapshot.
* @param eagerNames - tool names that stay directly visible (core + preload).
* @param bridgeNames - the bridge tool names (always visible).
* @param tier - the resolved disclosure tier.
* @returns the slimmed tools and manifest text (empty for tier 0).
*/
function computeDisclosure(entries, eagerNames, bridgeNames, tier) {
	if (tier === 0) return {
		tier,
		tools: entries.map(schemaOf),
		manifest: ""
	};
	const seen = /* @__PURE__ */ new Set();
	const tools = [];
	for (const entry of entries) if (eagerNames.has(entry.name) || bridgeNames.has(entry.name)) {
		seen.add(entry.name);
		tools.push(schemaOf(entry));
	}
	for (const name of bridgeNames) if (!seen.has(name)) tools.push({
		name,
		description: bridgeFallbackDescription(name),
		parameters: {
			type: "object",
			properties: {}
		}
	});
	const deferred = entries.filter((entry) => !eagerNames.has(entry.name) && !bridgeNames.has(entry.name));
	let manifest = "";
	if (deferred.length > 0) manifest = `${MANIFEST_HEADER}\n\n${tier === 1 ? buildGroupedManifest(deferred, "full") : tier === 2 ? buildGroupedManifest(deferred, "names") : buildGroupSummary(deferred)}`;
	return {
		tier,
		tools,
		manifest
	};
}
function bridgeFallbackDescription(name) {
	switch (name) {
		case "tool_search": return "Search the deferred tool catalog semantically and return ranked matches.";
		case "tool_describe": return "Load the full schema of one deferred tool.";
		case "tool_call": return "Invoke a deferred tool by name with its arguments.";
		default: return "Tool search bridge.";
	}
}
/**
* Apply the slimmed surface to an assembly: replace `assembly.tools` and, for
* tiers 1-3, append the manifest as a runtime context (sections may be
* replaced by a complete prompt; contexts survive). Pure and idempotent —
* the catalog comes from the registry, never from the incoming assembly.
* @param assembly - the settled assembly from the waterfall chain.
* @param disclosure - the computed slimmed surface.
* @returns the transformed assembly.
*/
function applyDisclosure(assembly, disclosure) {
	if (disclosure.tier === 0) return assembly;
	const contexts = [...assembly.contexts];
	if (disclosure.manifest !== "") contexts.push({
		name: MANIFEST_CONTEXT,
		text: disclosure.manifest
	});
	return {
		...assembly,
		tools: disclosure.tools,
		contexts
	};
}
function schemaOf(entry) {
	return {
		name: entry.name,
		description: entry.description,
		parameters: entry.parameters
	};
}
//#endregion
//#region lib/types/optimizer/engine.js
function schemaTokens(entries) {
	return entries.reduce((total, entry) => total + estimateTokens$1(JSON.stringify({
		name: entry.name,
		description: entry.description,
		parameters: entry.parameters
	})), 0);
}
/** Extract the last non-empty user text from a session, or `''` when none. */
function lastUserText(session) {
	const derive = session.deriveMessages;
	if (derive === void 0) return "";
	const messages = derive.call(session);
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j -= 1) {
			const block = content[j];
			if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return block.text;
		}
	}
	return "";
}
function errorMessage$1(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
/** The agent behind a scope key, when the runtime supplied one. */
function agentOf(scope) {
	if (scope === void 0 || scope === null) return void 0;
	return scope.session !== void 0 ? scope : void 0;
}
/** The session workspace of an agent, when the session carries one. */
function cwdOf(agent) {
	return agent?.session.header.cwd;
}
/**
* The context optimizer engine resolves runtime config, computes the slimmed
* model-visible tool surface per assembly, serves the bridge and setup tools,
* and maintains the per-session warm set that dynamically injects discovered
* tools back into the visible context. One instance per plugin load.
*/
var ToolSearchEngine = class {
	ctx;
	config;
	store;
	/** Session id → tool name → last-use sequence (warm set, LRU-bounded). */
	warm = /* @__PURE__ */ new Map();
	/** Sessions whose preload already ran. */
	preloadedSessions = /* @__PURE__ */ new Set();
	warmSeq = 0;
	constructor(ctx, config, store) {
		this.ctx = ctx;
		this.config = config;
		this.store = store;
	}
	/**
	* Transform one settled assembly: replace `assembly.tools` with the eager
	* core, bridge tools, and warm tools, and append the tiered manifest as a
	* runtime context (sections may be clobbered by a complete prompt; contexts
	* survive). Tier 0 returns the assembly untouched. Idempotent: the catalog
	* is re-read from the registry on every call.
	* @param assembly - the settled assembly from the waterfall chain.
	* @param scope - the calling agent (or undefined for the global view).
	* @returns the transformed assembly.
	*/
	async assemble(assembly, scope) {
		const agent = agentOf(scope);
		const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
		const groups = runtime.config.groups ?? [];
		const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? void 0), groups);
		const eager = await this.eagerNames(agent, entries, runtime.config);
		const deferred = entries.filter((entry) => !eager.has(entry.name));
		if (deferred.length === 0) return assembly;
		const forced = this.config.enabled === "on";
		if (!forced && entries.length <= this.config.minCatalogSize) return assembly;
		const budget = budgetFor(this.config.thresholdPct, this.config.contextWindow, this.config.listingMaxTokens);
		const tier = computeTier({
			catalogSize: entries.length,
			deferredSize: deferred.length,
			manifestTokens: estimateTokens$1(buildGroupedManifest(deferred, "full")),
			namesOnlyTokens: estimateTokens$1(buildGroupedManifest(deferred, "names")),
			budget,
			minCatalogSize: this.config.minCatalogSize,
			forced
		});
		return applyDisclosure(assembly, computeDisclosure(entries, eager, new Set(BRIDGE_NAMES), tier));
	}
	/**
	* Inspect the registered and effective model-visible tool surfaces for one
	* session. The result uses the exact disclosure calculation used by
	* `assemble()`, making optimisation savings observable to the audit layer.
	*/
	async analyzeSurface(scope) {
		const agent = agentOf(scope);
		const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
		const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? void 0), runtime.config.groups ?? []);
		const eager = await this.eagerNames(agent, entries, runtime.config);
		const deferred = entries.filter((entry) => !eager.has(entry.name));
		const forced = this.config.enabled === "on";
		const active = this.config.enabled !== "off" && deferred.length > 0 && (forced || entries.length > this.config.minCatalogSize);
		const budget = budgetFor(this.config.thresholdPct, this.config.contextWindow, this.config.listingMaxTokens);
		const tier = active ? computeTier({
			catalogSize: entries.length,
			deferredSize: deferred.length,
			manifestTokens: estimateTokens$1(buildGroupedManifest(deferred, "full")),
			namesOnlyTokens: estimateTokens$1(buildGroupedManifest(deferred, "names")),
			budget,
			minCatalogSize: this.config.minCatalogSize,
			forced
		}) : 0;
		const disclosure = computeDisclosure(entries, eager, new Set(BRIDGE_NAMES), tier);
		const registeredSchemaTokens = schemaTokens(entries);
		const visibleSchemaTokens = schemaTokens(snapshotCatalog(disclosure.tools, []));
		const manifestTokens = estimateTokens$1(disclosure.manifest);
		return {
			active: tier !== 0,
			tier,
			registeredTools: entries.length,
			registeredSchemaTokens,
			visibleTools: disclosure.tools.length,
			visibleSchemaTokens,
			deferredTools: deferred.length,
			manifestTokens,
			savedTokens: Math.max(0, registeredSchemaTokens - visibleSchemaTokens - manifestTokens),
			warmTools: this.warmNamesFor(agent)
		};
	}
	/**
	* Search the deferred catalog. Uses the configured rerank matcher when
	* present; falls back to keyword matching when absent or on rerank failure,
	* so `tool_search` never dead-ends. Also warms the matched tools into the
	* session's visible set (dynamic injection).
	* @param query - the model's search query.
	* @param limit - requested result count (clamped to config bounds).
	* @param scope - the calling agent.
	* @returns matches plus the ranking mode used.
	*/
	async search(query, limit, scope) {
		const agent = agentOf(scope);
		const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
		const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? void 0), runtime.config.groups ?? []);
		const eager = await this.eagerNames(agent, entries, runtime.config);
		const deferred = entries.filter((entry) => !eager.has(entry.name));
		const bounded = Math.min(Math.max(limit ?? this.config.searchDefaultLimit, 1), this.config.maxSearchLimit);
		const matcher = runtime.config.matcher;
		if (matcher === void 0) {
			const matches = keywordSearch(query, deferred, bounded);
			this.warmTools(agent, matches.map((match) => match.name));
			return {
				matches,
				mode: "keyword",
				hint: "no rerank matcher configured: run the tool-slimmer-setup skill to configure one for semantic ranking"
			};
		}
		try {
			const matches = await searchCatalog(matcher, query, deferred, bounded, this.config.matcherTimeoutMs);
			this.warmTools(agent, matches.map((match) => match.name));
			return {
				matches,
				mode: "rerank"
			};
		} catch (error) {
			this.ctx.logger.warn(`dsh-context-optimizer: rerank failed, falling back to keyword matching: ${errorMessage$1(error)}`);
			const matches = keywordSearch(query, deferred, bounded);
			this.warmTools(agent, matches.map((match) => match.name));
			return {
				matches,
				mode: "keyword",
				hint: `rerank failed (${errorMessage$1(error)}); fell back to keyword matching`
			};
		}
	}
	/**
	* Resolve the full schema of one catalog tool and warm it into the session.
	* @param name - the tool name.
	* @param scope - the calling agent.
	* @returns the model-facing schema fields, or `undefined` when unknown.
	*/
	describe(name, scope) {
		const agent = agentOf(scope);
		const schema = describeTool(snapshotCatalog(this.ctx.tools.schemas(agent ?? void 0), []), name);
		if (schema !== void 0) this.warmTools(agent, [name]);
		return schema;
	}
	/** The grouped catalog view the setup skill reads to propose grouping. */
	async catalogView(scope) {
		const agent = agentOf(scope);
		const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
		const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? void 0), runtime.config.groups ?? []);
		const eager = await this.eagerNames(agent, entries, runtime.config);
		return buildCatalogView(entries, new Set(entries.filter((entry) => !eager.has(entry.name)).map((entry) => entry.name)));
	}
	/**
	* Validate and persist a runtime config update, then drop stale caches.
	* @param input - groups/matcher/preload/core changes and the target scope.
	* @param scope - the calling agent (drives the default scope and workspace).
	* @returns the written path, effective scope, and a summary for the model.
	*/
	async updateConfig(input, scope) {
		const agent = agentOf(scope);
		const current = await this.store.resolve(this.config.configScope, cwdOf(agent));
		const target = input.scope ?? current.scope;
		if (input.groups !== void 0) {
			const reason = validateGroups(input.groups);
			if (reason !== void 0) throw new Error(`invalid groups: ${reason}`);
		}
		const next = {
			...current.config,
			...input.groups !== void 0 ? { groups: input.groups } : {},
			...input.matcher !== void 0 ? { matcher: input.matcher } : {},
			...input.preload !== void 0 ? { preload: input.preload } : {},
			...input.core !== void 0 ? { core: input.core } : {}
		};
		const path = await this.store.write(target, cwdOf(agent), next);
		this.warm.clear();
		this.preloadedSessions.clear();
		return {
			path,
			scope: target,
			groups: (next.groups ?? []).map((group) => ({
				name: group.name,
				tools: [...group.tools ?? [], ...group.prefixes ?? []]
			})),
			matcherConfigured: next.matcher !== void 0,
			preloadEnabled: next.preload?.enabled === true
		};
	}
	/**
	* Add tools to a session's warm set, LRU-bounded by `maxWarmTools`. Warm
	* tools are injected into the visible context on subsequent assemblies.
	* @param agent - the owning agent (warmth is per session).
	* @param names - tool names to warm.
	*/
	warmTools(agent, names) {
		const session = agent?.session;
		if (session === void 0 || names.length === 0) return;
		let set = this.warm.get(session.id);
		if (set === void 0) {
			set = /* @__PURE__ */ new Map();
			this.warm.set(session.id, set);
		}
		for (const name of names) set.set(name, ++this.warmSeq);
		while (set.size > this.config.maxWarmTools) {
			let oldest;
			let oldestSeq = Number.POSITIVE_INFINITY;
			for (const [name, seq] of set) if (seq < oldestSeq) {
				oldestSeq = seq;
				oldest = name;
			}
			if (oldest === void 0) break;
			set.delete(oldest);
		}
	}
	/** The names of a session's warm tools, in warm order (oldest first). */
	warmNamesFor(agent) {
		if (agent === void 0) return [];
		return [...(this.warm.get(agent.session.id) ?? /* @__PURE__ */ new Map()).keys()];
	}
	async eagerNames(agent, entries, runtime) {
		const preload = await this.preloadNames(agent, entries, runtime);
		return new Set([
			...this.config.core,
			...runtime.core ?? [],
			...FORCED_EAGER,
			...this.warmNamesFor(agent),
			...preload
		]);
	}
	async preloadNames(agent, entries, runtime) {
		const preload = runtime.preload;
		if (preload?.enabled !== true || runtime.matcher === void 0) return [];
		const session = agent?.session;
		if (session === void 0 || this.preloadedSessions.has(session.id)) return [];
		const query = lastUserText(session);
		if (query === "") return [];
		this.preloadedSessions.add(session.id);
		try {
			const names = (await searchCatalog(runtime.matcher, query, entries, preload.topK, this.config.matcherTimeoutMs)).map((match) => match.name);
			this.warmTools(agent, names);
			return names;
		} catch (error) {
			this.ctx.logger.warn(`dsh-context-optimizer: preload failed: ${errorMessage$1(error)}`);
			return [];
		}
	}
};
//#endregion
//#region lib/types/optimizer/setup.js
/** The setup/management tool names; always eager and never bridged. */
const MANAGEMENT_NAMES = ["tool_slimmer_catalog", "tool_slimmer_update_config"];
function textRender(_args, value) {
	return [{
		type: "text",
		text: typeof value === "string" ? value : JSON.stringify(value)
	}];
}
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
/** Shape-validate the update input before it reaches the engine. */
function validateUpdateInput(input) {
	let scope;
	let groups;
	let matcher;
	let preload;
	let core;
	if (input.scope !== void 0) {
		if (input.scope !== "user" && input.scope !== "project") throw new Error("\"scope\" must be \"user\" or \"project\"");
		scope = input.scope;
	}
	if (input.groups !== void 0) {
		if (!Array.isArray(input.groups)) throw new Error("\"groups\" must be an array");
		groups = input.groups.map((group) => {
			if (group === null || typeof group !== "object" || Array.isArray(group)) throw new Error("each group must be an object with a \"name\"");
			const record = group;
			if (typeof record.name !== "string" || record.name === "") throw new Error("each group needs a non-empty string \"name\"");
			const tools = arrayOfStrings(record.tools, "tools");
			const prefixes = arrayOfStrings(record.prefixes, "prefixes");
			return {
				name: record.name,
				...tools !== void 0 ? { tools } : {},
				...prefixes !== void 0 ? { prefixes } : {}
			};
		});
	}
	if (input.matcher !== void 0) {
		if (input.matcher === null || typeof input.matcher !== "object" || Array.isArray(input.matcher)) throw new Error("\"matcher\" must be an object with endpoint, apiKey, and model");
		const record = input.matcher;
		for (const key of [
			"endpoint",
			"apiKey",
			"model"
		]) if (typeof record[key] !== "string" || record[key] === "") throw new Error(`matcher "${key}" must be a non-empty string`);
		const topN = record.topN;
		if (topN !== void 0 && (typeof topN !== "number" || !Number.isInteger(topN) || topN <= 0)) throw new Error("matcher \"topN\" must be a positive integer");
		matcher = {
			endpoint: record.endpoint,
			apiKey: record.apiKey,
			model: record.model,
			...topN !== void 0 ? { topN } : {}
		};
	}
	if (input.preload !== void 0) {
		if (input.preload === null || typeof input.preload !== "object" || Array.isArray(input.preload)) throw new Error("\"preload\" must be an object with \"enabled\" and \"topK\"");
		const record = input.preload;
		if (typeof record.enabled !== "boolean") throw new Error("preload \"enabled\" must be a boolean");
		if (typeof record.topK !== "number" || !Number.isInteger(record.topK) || record.topK <= 0) throw new Error("preload \"topK\" must be a positive integer");
		preload = {
			enabled: record.enabled,
			topK: record.topK
		};
	}
	if (input.core !== void 0) core = arrayOfStrings(input.core, "core");
	return {
		...scope !== void 0 ? { scope } : {},
		...groups !== void 0 ? { groups } : {},
		...matcher !== void 0 ? { matcher } : {},
		...preload !== void 0 ? { preload } : {},
		...core !== void 0 ? { core } : {}
	};
}
function arrayOfStrings(value, where) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`"${where}" must be an array of strings`);
	return value;
}
/**
* Register the setup/management tools the bundled skill drives: a catalog
* reader and a config writer.
* @param ctx - the plugin context.
* @param engine - the engine backing catalog reads and config writes.
* @returns the combined disposer for both registrations.
*/
function registerManagementTools(ctx, engine) {
	const disposers = [ctx.tools.register(defineTool({
		name: "tool_slimmer_catalog",
		description: "List the full tool registry catalog (every tool, visible or deferred). Use this to plan tool groups with the user. The model-visible set may be smaller when the bridge is active.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: textRender
		},
		async execute(_args, exec) {
			try {
				return JSON.stringify(await engine.catalogView(exec.agent));
			} catch (error) {
				return JSON.stringify({ error: errorMessage(error) });
			}
		}
	})), ctx.tools.register(defineTool({
		name: "tool_slimmer_update_config",
		description: "Validate and persist Context Optimizer tool configuration (groups, rerank matcher, optional preload, extra core tools) to the user or project config file.",
		parameters: {
			scope: {
				type: "string",
				enum: ["user", "project"]
			},
			groups: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: true,
					properties: {
						name: { type: "string" },
						tools: {
							type: "array",
							items: { type: "string" }
						},
						prefixes: {
							type: "array",
							items: { type: "string" }
						}
					}
				}
			},
			matcher: {
				type: "object",
				additionalProperties: true,
				properties: {
					endpoint: { type: "string" },
					apiKey: { type: "string" },
					model: { type: "string" },
					topN: { type: "integer" }
				}
			},
			preload: {
				type: "object",
				additionalProperties: true,
				properties: {
					enabled: { type: "boolean" },
					topK: { type: "integer" }
				}
			},
			core: {
				type: "array",
				items: { type: "string" }
			}
		},
		output: {
			schema: { type: "string" },
			render: textRender
		},
		async execute(args, exec) {
			try {
				const input = validateUpdateInput(args ?? {});
				return JSON.stringify(await engine.updateConfig(input, exec.agent));
			} catch (error) {
				return JSON.stringify({ error: errorMessage(error) });
			}
		}
	}))];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** The bundled onboarding skill body (registered at plugin load). */
const SETUP_SKILL_CONTENT = `# tool-slimmer-setup

Configure Context Optimizer: group tools conversationally, configure the rerank matcher, and optionally enable per-session preload.

## When to use
- The user asks to group tools, set up tool search, configure the rerank model, enable preload, or change where the tool-search config lives.
- \`tool_search\` reports "no rerank matcher configured" or "fell back to keyword matching" and the user wants semantic ranking.

## Workflow
1. Call \`tool_slimmer_catalog\` to read the current tool registry catalog (names, descriptions, and existing groups). It lists EVERY tool — the model-visible set may be smaller when the bridge is active.
2. Propose a grouping in the conversation: group tools by domain (git, web, mcp-*, media, data, ...), using exact tool names or shared name prefixes. Keep the number of groups small (5-12) and every tool in at most one group.
3. Present the proposal and ask the user to confirm or adjust. Iterate until the user accepts.
4. Ask whether the config should be global (user-level) or per-project. When per-project, the config is written to \`.dsh/dsh-context-optimizer.json\` under the current project.
5. ALWAYS explain and offer the rerank matcher before writing the config: \`tool_search\` ranks with it, and it is required for preload. Describe what it is — an OpenAI-compatible \`/v1/rerank\` endpoint (for example DashScope compatible-mode with \`qwen3-reranker\`) — and ask the user for \`endpoint\`, \`apiKey\`, and \`model\`. If they cannot provide one now, proceed without it: \`tool_search\` then uses the built-in keyword fallback (exact-name and token matches), which works but ranks less well.
6. If the user wants preload, set \`preload: { enabled: true, topK: 5 }\` and confirm the matcher is configured (preload without a matcher stays inactive).
7. Write the confirmed configuration with \`tool_slimmer_update_config\` (groups, optional matcher, optional preload), then confirm the written path and the returned summary with the user. Mention that searched/described/called tools are automatically injected into the context for later turns.`;
/**
* Register the bundled onboarding skill so the model can run conversational
* grouping and matcher setup on request.
* @param ctx - the plugin context.
* @returns the skill registration disposer.
*/
function registerSetupSkill(ctx) {
	return ctx.skills.register({
		name: "tool-slimmer-setup",
		description: "Configure Context Optimizer tool groups, rerank matcher, and optional preload.",
		content: SETUP_SKILL_CONTENT,
		source: "bundled"
	});
}
//#endregion
//#region lib/types/audit/tokens.js
/**
* 启发式 token 估算。
*
* 不依赖外部 tokenizer：英文（ASCII）约 4 字符/token，中文等非 ASCII 约 1.5
* 字符/token。结果用于比较相对成本与趋势，不是精确计数（精确值以模型
* tokenizer 为准）。
*/
function estimateTokens(text) {
	let ascii = 0;
	let nonAscii = 0;
	for (const ch of text) if (ch.codePointAt(0) < 128) ascii++;
	else nonAscii++;
	return Math.ceil(ascii / 4 + nonAscii / 1.5);
}
/**
* 把 token 数格式化为人类可读：1234 -> "1.2k"，50000 -> "50k"。
*
* 浏览器半区也直接引这个函数——本模块无 node 依赖，纯字符串运算。面板此前
* 自带过一份副本，两份漂移后同一个数字在报告里显示 "50.0k"、在面板里 "50k"。
*/
function formatTokens(n) {
	if (n < 1e3) return String(n);
	const k = n / 1e3;
	if (k >= 100 || Number.isInteger(k)) return `${Math.round(k)}k`;
	return `${k.toFixed(1)}k`;
}
/** 把字节数格式化为人类可读。 */
function formatBytes(n) {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}
//#endregion
//#region lib/types/audit/analyze.js
/**
* 重复 / 冲突检测的纯函数集合。不依赖任何 DSH 运行时，可独立测试。
*/
/** 把文本切成"连续非空行"块（空行是分块边界）。 */
function splitBlocks(content) {
	const lines = content.split(/\r?\n/);
	const blocks = [];
	let current = [];
	const flush = () => {
		if (current.length > 0) {
			blocks.push(current.join("\n"));
			current = [];
		}
	};
	for (const line of lines) if (line.trim() === "") flush();
	else current.push(line);
	flush();
	return blocks;
}
/**
* 跨文件完全相同的段落块检测。
* @param files - 待比较的文件列表
* @param minLen - 小于该长度的块不参与（避免噪音）
* @returns 按 token 数降序的重复块
*/
function findDuplicateBlocks(files, minLen = 40) {
	const buckets = /* @__PURE__ */ new Map();
	for (const file of files) {
		const seen = /* @__PURE__ */ new Set();
		for (const block of splitBlocks(file.content)) {
			if (block.length < minLen || seen.has(block)) continue;
			seen.add(block);
			const list = buckets.get(block);
			if (list !== void 0) list.push(file.path);
			else buckets.set(block, [file.path]);
		}
	}
	const out = [];
	for (const [text, paths] of buckets) if (paths.length >= 2) out.push({
		text,
		tokens: estimateTokens(text),
		paths: [...paths].sort()
	});
	return out.sort((a, b) => b.tokens - a.tokens);
}
function findRankShadows(skills) {
	const byName = /* @__PURE__ */ new Map();
	for (const skill of skills) {
		const list = byName.get(skill.name);
		if (list !== void 0) list.push(skill);
		else byName.set(skill.name, [skill]);
	}
	const out = [];
	for (const [name, list] of byName) {
		if (list.length < 2) continue;
		const sorted = [...list].sort((a, b) => a.rank - b.rank || a.provider.localeCompare(b.provider));
		const winner = sorted[0];
		if (winner === void 0) continue;
		out.push({
			name,
			winner: {
				source: winner.source,
				provider: winner.provider
			},
			shadowed: sorted.slice(1).map((s) => ({
				source: s.source,
				provider: s.provider
			}))
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
function groupMcpTools(schemas) {
	const byServer = /* @__PURE__ */ new Map();
	for (const schema of schemas) {
		if (!schema.name.startsWith("mcp__")) continue;
		const server = schema.name.split("__")[1] ?? "unknown";
		const cur = byServer.get(server) ?? {
			tools: 0,
			tokens: 0
		};
		cur.tools++;
		cur.tokens += estimateTokens(schema.name) + estimateTokens(schema.description ?? "");
		byServer.set(server, cur);
	}
	const servers = [...byServer.entries()].map(([server, v]) => ({
		server,
		tools: v.tools,
		schemaTokens: v.tokens
	})).sort((a, b) => b.schemaTokens - a.schemaTokens);
	return {
		servers,
		totalTools: servers.reduce((acc, s) => acc + s.tools, 0),
		totalTokens: servers.reduce((acc, s) => acc + s.schemaTokens, 0)
	};
}
const CATALOGS = {
	en: {
		sep: ", ",
		"r.title": "# Context Doctor audit report (cwd: {cwd})",
		"r.s1": "## 1. Instruction chain (AGENTS.md / CLAUDE.md)",
		"r.instFiles": "- Injected files: {n}, {tokens} tokens total",
		"r.instFile": "  - {path} ({tokens} tokens / {bytes})",
		"r.dupBlocks": "- ⚠ Duplicated blocks across files: {n}",
		"r.dupBlock": "  - {tokens} tokens × {files} files: {paths}",
		"r.noDup": "- No duplicated blocks across files",
		"r.s2": "## 2. Skills catalog (resident in every request)",
		"r.skills": "- {n} skills, {tokens} tokens of descriptions",
		"r.skillSource": "  - {source}: {count} skills / {tokens} tokens",
		"r.bodies": "- Skill bodies (loaded on demand): {n} counted, ~{tokens} tokens",
		"r.dupDesc": "- ⚠ Identical descriptions: {n} groups",
		"r.dupDescItem": "  - {count} skills share one description (e.g. \"{name}\")",
		"r.s3": "## 3. Tool schemas (resident in every request)",
		"r.tools": "- {n} visible tools, {tokens} tokens of schema ({native} built-in / {nativeTokens} tokens)",
		"r.mcp": "- MCP: {n} tools / {tokens} tokens",
		"r.mcpServer": "  - {server}: {tools} tools / {tokens} tokens",
		"r.s4": "## 4. Same-name skill conflicts (rank shadow)",
		"r.conflict": "- {name}: {winner} wins; {shadowed} shadowed",
		"r.s5": "## 5. Suggestions ({n})",
		"r.noIssues": "- Nothing notable; the current injection surface is healthy.",
		"s.instHeavy": "The instruction chain is heavy ({tokens} tokens). Trim AGENTS.md / CLAUDE.md so each layer keeps only the rules unique to it.",
		"s.dupBlock": "A duplicated block ({tokens} tokens) appears in {n} files: {paths}. Keep one copy and link to it from the rest.",
		"s.skillCatalog": "Skill catalog descriptions cost {tokens} tokens ({n} skills, carried in every request). Shorten the descriptions or install fewer skills.",
		"s.dupSkillDesc": "{n} skills share an identical description (e.g. \"{name}\"). The catalog is paying for it twice — merge them or make the descriptions distinct.",
		"s.skillBodies": "{n} skill bodies counted, ~{tokens} tokens (loaded on demand, not resident in requests).",
		"s.mcpBloat": "The MCP tool surface is large: {n} tools, ~{tokens} tokens of schema. Largest servers: {servers}. Drop the servers or tools you do not need.",
		"s.manyTools": "{n} tools are visible (~{tokens} tokens of schema) and every request carries all of them. Check whether they are all needed.",
		"s.conflict": "Skill \"{name}\" comes from several sources: {winner} wins and {shadowed} are shadowed. The model only ever loads the winner."
	},
	zh: {
		sep: "、",
		"r.title": "# Context Doctor 审计报告（cwd: {cwd}）",
		"r.s1": "## 1. 指令链（AGENTS.md / CLAUDE.md）",
		"r.instFiles": "- 注入文件：{n} 个，共 {tokens} token",
		"r.instFile": "  - {path}（{tokens} token / {bytes}）",
		"r.dupBlocks": "- ⚠ 跨文件重复段落：{n} 处",
		"r.dupBlock": "  - {tokens} token × {files} 文件：{paths}",
		"r.noDup": "- 未发现跨文件重复段落",
		"r.s2": "## 2. 技能目录（catalog，每请求常驻）",
		"r.skills": "- {n} 个技能，摘要共 {tokens} token",
		"r.skillSource": "  - {source}: {count} 个 / {tokens} token",
		"r.bodies": "- 技能正文（按需加载）：已统计 {n} 个，共约 {tokens} token",
		"r.dupDesc": "- ⚠ 描述重复：{n} 组",
		"r.dupDescItem": "  - {count} 个技能共用描述（如「{name}」）",
		"r.s3": "## 3. 工具 schema（每请求常驻）",
		"r.tools": "- 可见工具 {n} 个，schema 共 {tokens} token（其中原生 {native} 个 / {nativeTokens} token）",
		"r.mcp": "- MCP：{n} 个工具 / {tokens} token",
		"r.mcpServer": "  - {server}: {tools} 工具 / {tokens} token",
		"r.s4": "## 4. 同名技能冲突（rank shadow）",
		"r.conflict": "- {name}: {winner} 胜出；{shadowed} 被 shadow",
		"r.s5": "## 5. 建议（{n} 条）",
		"r.noIssues": "- 未发现明显问题，当前注入面健康。",
		"s.instHeavy": "指令链总 token 偏高（{tokens}），建议精简 AGENTS.md/CLAUDE.md，只保留每层独有的规则。",
		"s.dupBlock": "重复段落（{tokens} token）出现在 {n} 个文件：{paths}。建议只保留一处，其余改为链接。",
		"s.skillCatalog": "技能 catalog 摘要占用 {tokens} token（{n} 个技能，每个请求都会携带），建议缩短 description 或减少技能数量。",
		"s.dupSkillDesc": "{n} 个技能描述完全相同（如「{name}」），catalog 存在冗余，建议合并或差异化描述。",
		"s.skillBodies": "已统计 {n} 个技能正文，共约 {tokens} token（按需加载，不常驻请求）。",
		"s.mcpBloat": "MCP 工具面膨胀：{n} 个工具、schema 约 {tokens} token。最大服务器：{servers}。建议裁剪不需要的服务器或工具。",
		"s.manyTools": "可见工具共 {n} 个（schema 约 {tokens} token），每个请求都会携带，建议检查是否全部需要。",
		"s.conflict": "技能「{name}」存在多个来源：{winner} 胜出，{shadowed} 被 shadow，模型只会加载胜出者。"
	}
};
/**
* Normalize any language tag to a catalog this plugin ships.
* @param preference - a BCP 47-ish tag (`zh`, `zh-CN`, `en-US`), or anything else.
* @returns the matching catalog id; English when there is no match.
*/
function resolveHostLocale(preference) {
	return typeof preference === "string" && preference.toLowerCase().startsWith("zh") ? "zh" : "en";
}
/**
* Bind a catalog.
* @param locale - catalog to read; defaults to English.
* @returns the lookup used by the report renderer and the suggestion builder.
*/
function hostTranslate(locale = "en") {
	const catalog = CATALOGS[locale];
	return (key, params) => {
		const template = catalog[key];
		if (params === void 0) return template;
		return template.replace(/\{(\w+)\}/g, (whole, name) => Object.hasOwn(params, name) ? String(params[name]) : whole);
	};
}
/** 指令链文件名（DSH 注入的 workspace instruction 文件）。 */
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"];
async function pathExists(fs, path, signal) {
	try {
		const target = await fs.resolve(path, { signal });
		return await fs.stat(target, signal) !== void 0;
	} catch {
		return false;
	}
}
/**
* 从 cwd 向上找到 git 根（含 .git 的最高目录）；从根到 cwd 的每一层收集
* AGENTS.md / CLAUDE.md，与 DSH 的 workspace instruction 注入链对齐。
*/
async function scanInstructionChain(fs, cwd, signal) {
	let root = cwd;
	let current = cwd;
	for (;;) {
		if (await pathExists(fs, join(current, ".git"), signal)) {
			root = current;
			break;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const layers = [];
	current = cwd;
	for (;;) {
		layers.push(current);
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	layers.reverse();
	const rawFiles = [];
	const seenPaths = /* @__PURE__ */ new Set();
	for (const dir of layers) for (const name of INSTRUCTION_NAMES) {
		const fullPath = join(dir, name);
		let target;
		try {
			target = await fs.resolve(fullPath, { signal });
		} catch {
			continue;
		}
		const realPath = fs.processPath(target);
		if (seenPaths.has(realPath)) continue;
		let info;
		try {
			info = await fs.stat(target, signal);
		} catch {
			continue;
		}
		if (info === void 0 || info.type !== "file") continue;
		if (info.size !== void 0 && info.size > 262144) continue;
		let text;
		try {
			text = await fs.readText(target, signal);
		} catch {
			continue;
		}
		if (rawFiles.some((file) => file.content === text)) {
			seenPaths.add(realPath);
			continue;
		}
		seenPaths.add(realPath);
		rawFiles.push({
			path: realPath,
			bytes: info.size ?? Buffer.byteLength(text),
			tokens: estimateTokens(text),
			content: text
		});
	}
	const totalTokens = rawFiles.reduce((acc, f) => acc + f.tokens, 0);
	const duplicateBlocks = findDuplicateBlocks(rawFiles.map((f) => ({
		path: f.path,
		content: f.content
	})));
	return {
		root,
		files: rawFiles.map(({ content: _content, ...rest }) => rest),
		totalTokens,
		duplicateBlocks
	};
}
async function scanSkillCatalog(skillList, signal) {
	const bySource = /* @__PURE__ */ new Map();
	let total = 0;
	for (const skill of skillList) {
		const tokens = estimateTokens(skill.description);
		total += tokens;
		const cur = bySource.get(skill.source) ?? {
			count: 0,
			descriptionTokens: 0
		};
		cur.count++;
		cur.descriptionTokens += tokens;
		bySource.set(skill.source, cur);
	}
	return {
		count: skillList.length,
		totalDescriptionTokens: total,
		bySource: [...bySource.entries()].map(([source, v]) => ({
			source,
			...v
		})).sort((a, b) => b.descriptionTokens - a.descriptionTokens),
		duplicateDescriptions: skillList.map((s) => ({
			name: s.name,
			description: s.description
		})).filter((s) => s.description !== "").reduce((acc, s) => {
			const key = s.description.trim().toLowerCase().replace(/\s+/g, " ");
			const hit = acc.find((h) => h.description.trim().toLowerCase().replace(/\s+/g, " ") === key);
			if (hit !== void 0) hit.count++;
			else acc.push({
				...s,
				count: 1
			});
			return acc;
		}, []).filter((h) => h.count >= 2).sort((a, b) => b.count - a.count)
	};
}
async function scanToolSchemas(tools, agent, signal) {
	let schemas = [];
	try {
		schemas = tools.schemas(agent);
	} catch {
		try {
			schemas = tools.schemas();
		} catch {
			schemas = [];
		}
	}
	let schemaTokens = 0;
	let nativeCount = 0;
	let nativeTokens = 0;
	const items = [];
	const mcpDuplicates = /* @__PURE__ */ new Map();
	for (const schema of schemas) {
		const serialised = stableJson(schema);
		const bytes = new TextEncoder().encode(serialised).byteLength;
		const tokens = estimateTokens(schema.name) + estimateTokens(schema.description ?? "");
		const server = schema.name.startsWith("mcp__") ? schema.name.split("__")[1] ?? "unknown" : void 0;
		const schemaHash = hashSchema(schema.name.startsWith("mcp__") ? stableJson({
			description: schema.description ?? "",
			parameters: schema.parameters ?? null
		}) : serialised);
		items.push({
			name: schema.name,
			bytes,
			tokens,
			schemaHash,
			...server !== void 0 ? { server } : {}
		});
		if (server !== void 0) {
			const duplicate = mcpDuplicates.get(schemaHash) ?? [];
			duplicate.push({
				name: schema.name,
				server,
				bytes
			});
			mcpDuplicates.set(schemaHash, duplicate);
		}
		schemaTokens += tokens;
		if (schema.name.startsWith("mcp__")) continue;
		nativeCount++;
		nativeTokens += tokens;
	}
	const mcp = groupMcpTools(schemas);
	return {
		visibleCount: schemas.length,
		schemaTokens,
		nativeCount,
		nativeTokens,
		mcp,
		items,
		mcpDuplicates
	};
}
function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
function hashSchema(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
//#endregion
//#region lib/types/audit/audit.js
/** 执行一次完整审计。 */
async function runAudit(deps, options) {
	const { fs, skills, tools } = deps;
	const { cwd, signal } = options;
	const skillLookup = {
		cwd,
		signal,
		...typeof options.agent === "object" && options.agent !== null ? { scope: options.agent } : {}
	};
	const skillList = await skills.list(skillLookup);
	const [instructions, skillCatalog, toolSchemas] = await Promise.all([
		scanInstructionChain(fs, cwd, signal),
		scanSkillCatalog(skillList, signal),
		scanToolSchemas(tools, options.agent, signal)
	]);
	let bodies;
	if (options.includeSkillBodies === true) {
		const max = Math.max(1, Math.min(options.maxSkillBodies ?? 20, 100));
		let count = 0;
		let totalTokens = 0;
		for (const summary of skillList.slice(0, max)) try {
			const def = await skills.get(summary.name, skillLookup);
			if (def !== void 0) {
				count++;
				totalTokens += estimateTokens(def.content);
			}
		} catch {}
		bodies = {
			count,
			totalTokens
		};
	}
	const conflicts = findRankShadows(skillList.map((s) => ({
		name: s.name,
		source: s.source,
		provider: s.provider,
		rank: rankOfSource(s.source)
	})));
	const suggestions = buildSuggestions({
		instructions,
		skills: {
			...skillCatalog,
			...bodies !== void 0 ? { bodies } : {}
		},
		tools: toolSchemas,
		conflicts
	}, options.locale ?? "en");
	const report = {
		tool: "context_audit",
		version: 1,
		cwd,
		injected: {
			instructions: {
				root: instructions.root,
				files: instructions.files,
				totalTokens: instructions.totalTokens,
				duplicateBlocks: instructions.duplicateBlocks.map((b) => ({
					tokens: b.tokens,
					paths: b.paths
				}))
			},
			skills: {
				catalogCount: skillCatalog.count,
				catalogDescriptionTokens: skillCatalog.totalDescriptionTokens,
				bySource: skillCatalog.bySource,
				duplicateDescriptions: skillCatalog.duplicateDescriptions,
				...bodies !== void 0 ? { bodies } : {}
			},
			tools: {
				visibleCount: toolSchemas.visibleCount,
				schemaTokens: toolSchemas.schemaTokens,
				nativeCount: toolSchemas.nativeCount,
				nativeTokens: toolSchemas.nativeTokens,
				mcp: toolSchemas.mcp
			}
		},
		conflicts,
		suggestions
	};
	if (options.detail === "developer") report.receipt = buildDeveloperReceipt({
		instructions,
		skillList,
		toolSchemas,
		conflicts,
		suggestions
	});
	return report;
}
function byteLength(value) {
	return new TextEncoder().encode(value).byteLength;
}
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function preview(value, max = 160) {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
function buildDeveloperReceipt(input) {
	const agentsFiles = input.instructions.files.map((file, index) => ({
		...file,
		loadOrder: index + 1,
		duplicateBlocks: input.instructions.duplicateBlocks.filter((block) => block.paths.includes(file.path)).map((block) => ({
			sha256: sha256(block.text),
			tokens: block.tokens,
			paths: block.paths,
			preview: preview(block.text)
		}))
	}));
	const skills = input.skillList.map((skill) => ({
		name: skill.name,
		source: skill.source,
		provider: skill.provider,
		descriptionBytes: byteLength(skill.description),
		descriptionTokens: estimateTokens(skill.description),
		catalogInjected: true
	}));
	const schemaItems = input.toolSchemas.items.map((item) => ({
		name: item.name,
		bytes: item.bytes,
		tokens: item.tokens,
		schemaHash: item.schemaHash,
		...item.server !== void 0 ? { server: item.server } : {}
	}));
	const duplicateMcpEntries = [...input.toolSchemas.mcpDuplicates.entries()].filter(([, items]) => items.length > 1).map(([schemaHash, items]) => ({
		schemaHash,
		names: items.map((item) => item.name).sort(),
		servers: [...new Set(items.map((item) => item.server))].sort(),
		bytes: items.reduce((total, item) => total + item.bytes, 0)
	})).sort((a, b) => b.bytes - a.bytes || a.schemaHash.localeCompare(b.schemaHash));
	return {
		kind: "context-audit-receipt",
		version: 1,
		detail: "developer",
		agentsFiles,
		skills,
		toolSchemas: {
			totalBytes: schemaItems.reduce((total, item) => total + item.bytes, 0),
			items: schemaItems
		},
		duplicateMcpEntries,
		shadowedSkills: input.conflicts,
		trimmed: {
			status: "unavailable",
			items: []
		},
		repairPlan: input.suggestions
	};
}
/** SkillSummary 的 rank 不在公开类型里；按来源给启发式排序值（与官方 rank 语义一致：低者胜）。 */
function rankOfSource(source) {
	switch (source) {
		case "project-dsh": return 100;
		case "project-agents": return 200;
		case "runtime": return 250;
		case "user-dsh": return 300;
		case "user-agents": return 400;
		case "custom": return 500;
		case "bundled": return 600;
		default: return 900;
	}
}
/** 按严重度排序的裁剪建议。 */
function buildSuggestions(input, locale = "en") {
	const t = hostTranslate(locale);
	const sep = t("sep");
	const out = [];
	if (input.instructions.totalTokens > 8e3) out.push({
		severity: "high",
		text: t("s.instHeavy", { tokens: formatTokens(input.instructions.totalTokens) })
	});
	for (const block of input.instructions.duplicateBlocks.slice(0, 5)) out.push({
		severity: "medium",
		text: t("s.dupBlock", {
			tokens: formatTokens(block.tokens),
			n: block.paths.length,
			paths: block.paths.join(sep)
		})
	});
	if (input.skills.totalDescriptionTokens > 3e3) out.push({
		severity: "medium",
		text: t("s.skillCatalog", {
			tokens: formatTokens(input.skills.totalDescriptionTokens),
			n: input.skills.count
		})
	});
	for (const dup of input.skills.duplicateDescriptions.slice(0, 5)) out.push({
		severity: "medium",
		text: t("s.dupSkillDesc", {
			n: dup.count,
			name: dup.name
		})
	});
	if (input.skills.bodies !== void 0 && input.skills.bodies.totalTokens > 2e4) out.push({
		severity: "low",
		text: t("s.skillBodies", {
			n: input.skills.bodies.count,
			tokens: formatTokens(input.skills.bodies.totalTokens)
		})
	});
	if (input.tools.mcp.totalTokens > 4e3 || input.tools.mcp.totalTools > 20) out.push({
		severity: "high",
		text: t("s.mcpBloat", {
			n: input.tools.mcp.totalTools,
			tokens: formatTokens(input.tools.mcp.totalTokens),
			servers: input.tools.mcp.servers.slice(0, 3).map((s) => `${s.server}(${s.tools})`).join(sep)
		})
	});
	if (input.tools.visibleCount > 40) out.push({
		severity: "low",
		text: t("s.manyTools", {
			n: input.tools.visibleCount,
			tokens: formatTokens(input.tools.schemaTokens)
		})
	});
	for (const conflict of input.conflicts.slice(0, 5)) out.push({
		severity: "medium",
		text: t("s.conflict", {
			name: conflict.name,
			winner: `${conflict.winner.source}(${conflict.winner.provider})`,
			shadowed: conflict.shadowed.map((s) => `${s.source}(${s.provider})`).join(sep)
		})
	});
	return out;
}
/** 把 canonical 报告渲染成模型可读文本。 */
function renderReport(report, locale = "en") {
	const t = hostTranslate(locale);
	const sep = t("sep");
	const lines = [];
	lines.push(t("r.title", { cwd: report.cwd }));
	lines.push("");
	const inst = report.injected.instructions;
	lines.push(t("r.s1"));
	lines.push(t("r.instFiles", {
		n: inst.files.length,
		tokens: formatTokens(inst.totalTokens)
	}));
	for (const f of inst.files) lines.push(t("r.instFile", {
		path: f.path,
		tokens: formatTokens(f.tokens),
		bytes: formatBytes(f.bytes)
	}));
	if (inst.duplicateBlocks.length > 0) {
		lines.push(t("r.dupBlocks", { n: inst.duplicateBlocks.length }));
		for (const b of inst.duplicateBlocks.slice(0, 5)) lines.push(t("r.dupBlock", {
			tokens: formatTokens(b.tokens),
			files: b.paths.length,
			paths: b.paths.join(sep)
		}));
	} else lines.push(t("r.noDup"));
	lines.push("");
	const sk = report.injected.skills;
	lines.push(t("r.s2"));
	lines.push(t("r.skills", {
		n: sk.catalogCount,
		tokens: formatTokens(sk.catalogDescriptionTokens)
	}));
	for (const s of sk.bySource) lines.push(t("r.skillSource", {
		source: s.source,
		count: s.count,
		tokens: formatTokens(s.descriptionTokens)
	}));
	if (sk.bodies !== void 0) lines.push(t("r.bodies", {
		n: sk.bodies.count,
		tokens: formatTokens(sk.bodies.totalTokens)
	}));
	if (sk.duplicateDescriptions.length > 0) {
		lines.push(t("r.dupDesc", { n: sk.duplicateDescriptions.length }));
		for (const d of sk.duplicateDescriptions.slice(0, 5)) lines.push(t("r.dupDescItem", {
			count: d.count,
			name: d.name
		}));
	}
	lines.push("");
	const tl = report.injected.tools;
	lines.push(t("r.s3"));
	lines.push(t("r.tools", {
		n: tl.visibleCount,
		tokens: formatTokens(tl.schemaTokens),
		native: tl.nativeCount,
		nativeTokens: formatTokens(tl.nativeTokens)
	}));
	if (tl.mcp.totalTools > 0) {
		lines.push(t("r.mcp", {
			n: tl.mcp.totalTools,
			tokens: formatTokens(tl.mcp.totalTokens)
		}));
		for (const s of tl.mcp.servers) lines.push(t("r.mcpServer", {
			server: s.server,
			tools: s.tools,
			tokens: formatTokens(s.schemaTokens)
		}));
	}
	lines.push("");
	if (report.conflicts.length > 0) {
		lines.push(t("r.s4"));
		for (const c of report.conflicts) lines.push(t("r.conflict", {
			name: c.name,
			winner: `${c.winner.source}(${c.winner.provider})`,
			shadowed: c.shadowed.map((s) => `${s.source}(${s.provider})`).join(sep)
		}));
		lines.push("");
	}
	lines.push(t("r.s5", { n: report.suggestions.length }));
	if (report.suggestions.length === 0) lines.push(t("r.noIssues"));
	for (const s of report.suggestions) lines.push(`- [${s.severity}] ${s.text}`);
	if (report.receipt !== void 0) {
		const receipt = report.receipt;
		lines.push("");
		lines.push("## Developer context-audit receipt");
		lines.push(`- AGENTS files: ${receipt.agentsFiles.length}`);
		for (const file of receipt.agentsFiles) {
			lines.push(`  - #${file.loadOrder} ${file.path}: ${formatBytes(file.bytes)} / ${formatTokens(file.tokens)} token`);
			for (const duplicate of file.duplicateBlocks) lines.push(`    - duplicate ${duplicate.sha256.slice(0, 12)}… (${formatTokens(duplicate.tokens)} token): ${duplicate.preview}`);
		}
		lines.push(`- Catalog-injected skills: ${receipt.skills.length}`);
		for (const skill of receipt.skills) lines.push(`  - ${skill.name} [${skill.source}/${skill.provider}]: ${formatBytes(skill.descriptionBytes)} / ${formatTokens(skill.descriptionTokens)} token`);
		lines.push(`- Tool schemas: ${formatBytes(receipt.toolSchemas.totalBytes)} serialized across ${receipt.toolSchemas.items.length} tools`);
		for (const duplicate of receipt.duplicateMcpEntries) lines.push(`  - duplicate MCP signature ${duplicate.schemaHash}: ${duplicate.names.join("、")} (${formatBytes(duplicate.bytes)})`);
		lines.push(`- Shadowed skills: ${receipt.shadowedSkills.length}`);
		lines.push(`- Trimmed entries: ${receipt.trimmed.status} (DSH assembly trace is not exposed)`);
	}
	return lines.join("\n");
}
//#endregion
//#region lib/types/audit/routes.js
/** 浏览器侧 API 前缀。 */
const AUDIT_API_PREFIX = "/api/context-optimizer";
/** 写 JSON 响应。 */
function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
/** 从查询字符串取单个参数（URL 解码；重复取首个）。 */
function parseQueryParam(url, key) {
	const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
	for (const part of query.split("&")) {
		if (!part.startsWith(`${key}=`)) continue;
		try {
			return decodeURIComponent(part.slice(key.length + 1));
		} catch {
			return;
		}
	}
}
/** 解析审计起点目录：显式 cwd > 会话 cwd > defaultCwd > 进程 cwd。 */
function resolveCwd(url, config) {
	const explicit = parseQueryParam(url, "cwd");
	if (explicit !== void 0 && explicit !== "") return explicit;
	const sessionId = parseQueryParam(url, "session");
	if (sessionId !== void 0 && sessionId !== "") {
		const session = config.sessions?.get(sessionId);
		if (session?.header.cwd !== void 0 && session.header.cwd !== "") return session.header.cwd;
	}
	return config.defaultCwd ?? process.cwd();
}
/** 构造审计路由（含 60s 缓存与 in-flight 复用）。 */
function makeAuditRoutes(config) {
	const { deps, cacheTtlMs = 6e4 } = config;
	const cache = /* @__PURE__ */ new Map();
	/** 缓存条目上限：防止不同 cwd 参数让缓存无限增长（超限时淘汰最旧条目）。 */
	const MAX_CACHE_ENTRIES = 32;
	const audit = (cwd, detail, agent, sessionId, locale) => {
		const key = `${detail} ${locale} ${sessionId} ${cwd}`;
		const hit = cache.get(key);
		if (hit !== void 0 && Date.now() - hit.at < cacheTtlMs) return hit.promise;
		if (cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== void 0) cache.delete(oldest);
		}
		const promise = config.runAudit === void 0 ? runAudit(deps, {
			cwd,
			detail,
			locale,
			signal: new AbortController().signal,
			...agent !== void 0 ? { agent } : {}
		}) : config.runAudit({
			cwd,
			detail,
			agent,
			locale
		}).catch((error) => {
			cache.delete(key);
			throw error;
		});
		cache.set(key, {
			at: Date.now(),
			promise
		});
		return promise;
	};
	return [{
		kind: "exact",
		path: `${AUDIT_API_PREFIX}/audit`,
		handler: (req, res) => {
			if (req.method !== "GET") {
				json(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				return;
			}
			const url = req.url ?? "";
			const cwd = resolveCwd(url, config);
			const detail = parseQueryParam(url, "detail") === "developer" ? "developer" : "summary";
			const sessionId = parseQueryParam(url, "session") ?? "";
			audit(cwd, detail, sessionId === "" ? void 0 : config.agents?.get(sessionId), sessionId, resolveHostLocale(parseQueryParam(url, "lang"))).then((report) => json(res, 200, {
				ok: true,
				report
			}), (error) => json(res, 500, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			}));
		}
	}];
}
//#endregion
//#region lib/types/index.js
const name = "dsh-context-optimizer";
const inject = [
	"fs",
	"skills",
	"tools",
	"sessions"
];
const BLOCKED_FROM_BRIDGE = new Set([
	...BRIDGE_NAMES,
	...MANAGEMENT_NAMES,
	"skill"
]);
const DEFAULT_TOOLS = {
	enabled: "auto",
	thresholdPct: 5,
	listingMaxTokens: 4e3,
	contextWindow: 128e3,
	searchDefaultLimit: 5,
	maxSearchLimit: 20,
	minCatalogSize: 12,
	configScope: "auto",
	core: ["todo_write"],
	matcherTimeoutMs: 15e3,
	maxWarmTools: 8
};
function reportLocale(ctx) {
	const section = ctx.get("settings")?.get("locale");
	return resolveHostLocale(section?.preference);
}
function renderOptimization(report, locale) {
	const s = report.optimization;
	if (locale === "zh") return `\n\n## 工具面优化\n- 当前档位：Tier ${s.tier}${s.active ? "" : "（未启用瘦身）"}\n- 注册表：${s.registeredTools} 个工具，约 ${s.registeredSchemaTokens} tokens\n- 模型可见：${s.visibleTools} 个 schema + ${s.manifestTokens} tokens 目录\n- 延迟工具：${s.deferredTools} 个；估算节省：${s.savedTokens} tokens\n- Warm 工具：${s.warmTools.length === 0 ? "无" : s.warmTools.join(", ")}`;
	return `\n\n## Tool surface optimisation\n- Current tier: Tier ${s.tier}${s.active ? "" : " (slimming inactive)"}\n- Registry: ${s.registeredTools} tools, about ${s.registeredSchemaTokens} tokens\n- Model-visible: ${s.visibleTools} schemas + ${s.manifestTokens} catalog tokens\n- Deferred: ${s.deferredTools}; estimated savings: ${s.savedTokens} tokens\n- Warm tools: ${s.warmTools.length === 0 ? "none" : s.warmTools.join(", ")}`;
}
/** Register the unified host plugin. */
function apply(ctx, config = {}) {
	const tools = {
		...DEFAULT_TOOLS,
		...config.tools
	};
	const engine = new ToolSearchEngine(ctx, tools, new RuntimeConfigStore((message) => ctx.logger.warn(message)));
	ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
		const settled = await next();
		if (tools.enabled === "off") return settled;
		return engine.assemble(settled, context.scope);
	});
	registerBridgeTools(ctx, {
		search: (query, limit, agent) => engine.search(query, limit, agent),
		describe: (toolName, agent) => engine.describe(toolName, agent),
		warm: (names, agent) => engine.warmTools(agent, names),
		canCall: (toolName, agent) => !BLOCKED_FROM_BRIDGE.has(toolName) && ctx.tools.get(toolName, agent) !== void 0
	});
	registerManagementTools(ctx, engine);
	registerSetupSkill(ctx);
	const auditDeps = {
		fs: ctx.fs,
		skills: ctx.skills,
		tools: ctx.tools
	};
	const audit = async (args) => {
		const [report, optimization] = await Promise.all([runAudit(auditDeps, {
			...args,
			locale: args.locale ?? reportLocale(ctx)
		}), engine.analyzeSurface(args.agent)]);
		return {
			...report,
			optimization
		};
	};
	ctx.tools.register(defineTool({
		name: "context_audit",
		description: "Audit context injected into every model request and report how Context Optimizer reduces the tool surface. Read-only: it never modifies audited files.",
		parameters: {
			cwd: {
				type: "string",
				description: "Directory to audit. Defaults to the current session workspace."
			},
			includeSkillBodies: {
				type: "boolean",
				description: "Also total skill-body tokens. Defaults to false."
			},
			maxSkillBodies: {
				type: "number",
				description: "Maximum skill bodies to count. Defaults to 20."
			},
			detail: {
				type: "string",
				enum: ["summary", "developer"],
				description: "Use developer for a per-entry receipt."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const report = value;
				const locale = reportLocale(ctx);
				return [{
					type: "text",
					text: renderReport(report, locale) + renderOptimization(report, locale)
				}];
			}
		},
		async execute(args, exec) {
			const agent = exec.agent;
			return await audit({
				cwd: args.cwd ?? agent?.session?.header?.cwd ?? config.audit?.defaultCwd ?? process.cwd(),
				signal: exec.signal,
				...args.includeSkillBodies !== void 0 ? { includeSkillBodies: args.includeSkillBodies } : {},
				...args.maxSkillBodies !== void 0 ? { maxSkillBodies: args.maxSkillBodies } : {},
				...args.detail === "developer" ? { detail: "developer" } : {},
				...exec.agent !== void 0 ? { agent: exec.agent } : {}
			});
		}
	}));
	const sessions = ctx.get("sessions");
	const agents = ctx.get("agents");
	const routes = makeAuditRoutes({
		deps: auditDeps,
		runAudit: async ({ cwd, detail, agent, locale }) => audit({
			cwd,
			signal: new AbortController().signal,
			locale,
			...detail === "developer" ? { detail } : {},
			...agent !== void 0 ? { agent } : {}
		}),
		...sessions !== void 0 ? { sessions } : {},
		...agents !== void 0 ? { agents } : {},
		...config.audit?.defaultCwd !== void 0 ? { defaultCwd: config.audit.defaultCwd } : {},
		...config.audit?.cacheTtlMs !== void 0 ? { cacheTtlMs: config.audit.cacheTtlMs } : {}
	});
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => {
			const disposers = routes.map((route) => webCtx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "context-optimizer: routes");
	});
	return engine;
}
//#endregion
export { apply, inject, name };
