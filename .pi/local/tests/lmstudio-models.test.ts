import assert from "node:assert/strict";
import test from "node:test";
import { modelFromLmStudio, modelsFromLmStudioPayload } from "../extensions/lib/lmstudio-models.ts";

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
			reasoning: true,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 32768,
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
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 8192,
			maxTokens: 8192,
		},
	);

	assert.equal(modelFromLmStudio({ id: "text-embed", type: "embeddings" }), null);
	assert.equal(modelFromLmStudio({ id: "  " }), null);
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
				reasoning: true,
				input: ["text"],
				contextWindow: 131072,
				maxTokens: 32768,
			},
		],
	);

	assert.deepEqual(modelsFromLmStudioPayload({}), []);
	assert.deepEqual(modelsFromLmStudioPayload(null), []);
});
