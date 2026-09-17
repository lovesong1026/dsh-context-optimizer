import z from '@deepseek-ai/schemastery';
import type { ConfigScope, RuntimeFileConfig, RuntimeScope, ToolSearchConfig } from './types.ts';
/** Runtime settings owned by the unified plugin. */
export declare const RUNTIME_FILE = "dsh-context-optimizer.json";
/**
 * Resolve the harness home: `$DSH_HOME` when set (tilde-expanded), else
 * `~/.dsh`. Local mirror of the harness `resolveDshHome` so the plugin needs
 * no extra peer dependency.
 * @returns the absolute harness home directory.
 */
export declare function resolveDshHome(): string;
/** Absolute path of the user-global runtime config file. */
export declare function userConfigPath(): string;
/** Absolute path of a project-level runtime config file. */
export declare function projectConfigPath(cwd: string): string;
/** Static engine tuning schema for cordis.yml. */
export declare const ToolSearchConfigSchema: z<ToolSearchConfig>;
/**
 * Parse and shape-validate a runtime config file. Throws with the offending
 * path and a concrete reason so a malformed file is never silently ignored.
 * @param text - the raw file text.
 * @param path - the file path, used in diagnostics.
 * @returns the validated runtime config.
 */
export declare function parseRuntimeFile(text: string, path: string): RuntimeFileConfig;
/**
 * Reads and caches runtime config files with mtime-based invalidation. A
 * missing file resolves to `undefined`; a malformed file logs a warning and
 * is treated as absent so a broken user file cannot break sessions.
 */
export declare class RuntimeConfigStore {
    private readonly cache;
    private readonly warn;
    constructor(warn: (message: string) => void);
    /** Absolute path of the user-global config file. */
    userPath(): string;
    /** Absolute path of the project config file for a workspace. */
    projectPath(cwd: string): string;
    /**
     * Resolve the effective runtime config for a workspace.
     * @param configScope - `user` (global only), `project` (project only, user
     *   fallback when absent), or `auto` (project when present, else user).
     * @param cwd - the session workspace, required for project resolution.
     * @returns the effective config, its scope, and the file path it came from.
     */
    resolve(configScope: ConfigScope, cwd: string | undefined): Promise<{
        config: RuntimeFileConfig;
        scope: RuntimeScope;
        path: string;
    }>;
    /**
     * Persist a runtime config file and invalidate its cache entry.
     * @param scope - where to write (`project` requires a workspace).
     * @param cwd - the session workspace for project writes.
     * @param data - the config to persist (version/scope stamped by the caller).
     * @returns the absolute path written.
     */
    write(scope: RuntimeScope, cwd: string | undefined, data: RuntimeFileConfig): Promise<string>;
    /** Drop all cached reads (used by tests and by the update tool). */
    invalidateAll(): void;
    private read;
}
