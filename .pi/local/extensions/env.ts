/**
 * Load cwd .env into process.env before other local extensions run.
 * Named env.ts so it loads before lmstudio.ts and paperless.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadLocalEnv } from "./lib/load-env.ts";

const loaded = loadLocalEnv();

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (loaded.path) {
			ctx.ui.notify(`Loaded ${loaded.path}`, "info");
			return;
		}
		ctx.ui.notify(`No .env in ${process.cwd()}`, "warning");
	});
}
