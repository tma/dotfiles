/**
 * Keep model requests on LM Studio.
 *
 * Every built-in provider is replaced with a blocker while extensions load,
 * before Pi picks a startup model. Cloud credentials in the environment or
 * auth.json then cannot select, restore, or reach a cloud model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { blockedProvider, LMSTUDIO_PROVIDER } from "./lib/local-only.ts";

export default function (pi: ExtensionAPI) {
	for (const id of getBuiltinProviders()) {
		if (id !== LMSTUDIO_PROVIDER) pi.registerProvider(blockedProvider(id));
	}
}
