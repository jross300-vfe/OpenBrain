/**
 * OpenRouter embedder — cloud-based, multi-model gateway.
 * Fallback option if Ollama is unavailable.
 */

import {
  type Embedder,
  type ThoughtMetadataExtracted,
  DEFAULT_METADATA,
  METADATA_PROMPT,
  assertUsableEmbedding,
} from "./types.js";

export class OpenRouterEmbedder implements Embedder {
  private readonly apiKey: string;
  private readonly embedModel: string;
  private readonly llmModel: string;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY ?? "";
    this.embedModel = process.env.OPENROUTER_EMBED_MODEL ?? "openai/text-embedding-3-small";
    this.llmModel = process.env.OPENROUTER_LLM_MODEL ?? "openai/gpt-4o-mini";

    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required when using openrouter provider");
    }

    console.log(
      `[embedder] OpenRouter (embed: ${this.embedModel}, llm: ${this.llmModel})`
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.embedModel, input: text }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter embed failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    // S275 (task_1787400000011): the previous guard here was `if (!embedding)`,
    // and *** AN EMPTY ARRAY IS TRUTHY *** -- so a 200 carrying `[]` sailed
    // straight through and stored a thought permanently unfindable by search.
    return assertUsableEmbedding(data.data[0]?.embedding, {
      model: this.embedModel,
      contentBytes: Buffer.byteLength(text, "utf8"),
    });
  }

  async extractMetadata(content: string): Promise<ThoughtMetadataExtracted> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.llmModel,
        messages: [
          { role: "system", content: METADATA_PROMPT },
          { role: "user", content },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      console.warn(`[embedder] OpenRouter metadata extraction failed: ${response.status}`);
      return DEFAULT_METADATA;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    try {
      const raw = data.choices[0]?.message.content ?? "{}";
      const parsed = JSON.parse(raw) as ThoughtMetadataExtracted;
      return {
        type: parsed.type ?? "observation",
        topics: parsed.topics ?? [],
        people: parsed.people ?? [],
        action_items: parsed.action_items ?? [],
        dates: parsed.dates ?? [],
      };
    } catch (e) {
      console.warn("[embedder] Failed to parse metadata JSON:", e);
      return DEFAULT_METADATA;
    }
  }
}
