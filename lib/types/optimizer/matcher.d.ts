import type { CatalogEntry, RerankMatcherConfig, SearchMatch } from './types.ts';
/** One scored hit from a rerank response. */
export interface RerankHit {
    readonly index: number;
    readonly score: number;
}
/** OpenAPI-compatible `/v1/rerank` response projection. */
export interface RerankResponse {
    readonly results?: ReadonlyArray<{
        readonly index?: number;
        readonly relevance_score?: number;
    }>;
}
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
export declare function rerank(matcher: RerankMatcherConfig, query: string, documents: readonly string[], timeoutMs: number): Promise<RerankHit[]>;
/**
 * Semantically search the catalog through the configured rerank matcher.
 * @param matcher - the rerank configuration.
 * @param query - the model's search query.
 * @param entries - the deferred catalog rows.
 * @param limit - how many matches to return.
 * @param timeoutMs - rerank request deadline.
 * @returns matches sorted by relevance, capped at `limit`.
 */
export declare function searchCatalog(matcher: RerankMatcherConfig, query: string, entries: readonly CatalogEntry[], limit: number, timeoutMs: number): Promise<SearchMatch[]>;
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
export declare function keywordSearch(query: string, entries: readonly CatalogEntry[], limit: number): SearchMatch[];
