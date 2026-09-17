import assert from "node:assert/strict";
import test from "node:test";
import {
	compatForFamily,
	modelFamily,
	modelFromLmStudio,
	modelsFromLmStudioPayload,
} from "../extensions/lib/lmstudio-models.ts";

test("modelFromLmStudio reads v0 metadata and skips embeddings", () => {
	assert.deepEqual(
		modelFromLmStudio({
			id: "qwen3.6-27b-iq4xs",
			type: "llm",
			display_name: "Qwen 3.6 27B",
			max_context_length: 131072,
		}),
		{
			id: "qwen3.6-27b-iq4xs",
			name: "Qwen 3.6 27B",
			family: "qwen",
			reasoning: true,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 32768,
			compat: compatForFamily("qwen"),
		},
	);

	assert.deepEqual(
		modelFromLmStudio({
			id: "qwen-vl",
			type: "vlm",
			name: "Qwen VL",
			max_context_length: 8192,
		}),
		{
			id: "qwen-vl",
			name: "Qwen VL",
			family: "qwen",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 8192,
			maxTokens: 8192,
			compat: compatForFamily("qwen"),
		},
	);

	assert.equal(modelFromLmStudio({ id: "text-embed", type: "embeddings" }), null);
	assert.equal(modelFromLmStudio({ id: "  " }), null);
});

test("Gemma does not get the Qwen chat template", () => {
	assert.equal(modelFamily("gemma-4-12b", "Gemma 4 12B"), "gemma");
	const gemma = modelFromLmStudio({
		id: "gemma-4-12b",
		name: "Gemma 4 12B",
		arch: "gemma4",
	});
	assert.equal(gemma?.family, "gemma");
	assert.equal(gemma?.reasoning, false);
	assert.equal(gemma?.compat.thinkingFormat, undefined);
	assert.equal(compatForFamily("qwen").thinkingFormat, "qwen-chat-template");
});

test("modelsFromLmStudioPayload accepts v1 lists and drops duplicates", () => {
	assert.deepEqual(
		modelsFromLmStudioPayload({
			data: [
				{ id: "qwen3.6-27b-iq4xs" },
				{ id: "qwen3.6-27b-iq4xs" },
				{ id: "nomic-embed", type: "embedding" },
				{ object: "model" },
			],
		}),
		[
			{
				id: "qwen3.6-27b-iq4xs",
				name: "qwen3.6-27b-iq4xs",
				family: "qwen",
				reasoning: true,
				input: ["text"],
				contextWindow: 131072,
				maxTokens: 32768,
				compat: compatForFamily("qwen"),
			},
		],
	);

	assert.deepEqual(modelsFromLmStudioPayload({}), []);
	assert.deepEqual(modelsFromLmStudioPayload(null), []);
});
