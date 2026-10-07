import type { Provider } from "@earendil-works/pi-ai";

export const LMSTUDIO_PROVIDER = "lmstudio";

function refuse(id: string): never {
	throw new Error(`pi-local only sends model requests to LM Studio; provider "${id}" is blocked`);
}

// Stands in for a non-LM Studio provider. It lists no models, so nothing can
// select it. Its credentials never resolve, so Pi stops a request before
// dispatch even with a stored or ambient key. Streaming refuses as a backstop.
export function blockedProvider(id: string): Provider {
	return {
		id,
		name: `${id} (blocked by pi-local)`,
		auth: { apiKey: { name: "Blocked by pi-local", resolve: async () => undefined } },
		getModels: () => [],
		stream: () => refuse(id),
		streamSimple: () => refuse(id),
	};
}
