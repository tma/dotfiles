import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface GondolinToolProvider {
	readonly hostCwd: string;
	readonly tools: readonly ToolDefinition<any>[];
}

const GONDOLIN_TOOL_PROVIDER = Symbol.for("tma.pi.gondolin.tool-provider");

export function setGondolinToolProvider(provider: GondolinToolProvider | undefined): void {
	(globalThis as any)[GONDOLIN_TOOL_PROVIDER] = provider;
}

/** Returns tools bound to the parent Gondolin VM without loading its runtime. */
export function getGondolinToolProvider(): GondolinToolProvider | undefined {
	return (globalThis as any)[GONDOLIN_TOOL_PROVIDER] as GondolinToolProvider | undefined;
}
