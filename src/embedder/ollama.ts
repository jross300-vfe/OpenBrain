/**
 * Ollama embedder — local, free, private.
 * Uses your existing ollama-gpu-bridge in the K8s cluster.
 */

import {
  type Embedder,
  type ThoughtMetadataExtracted,
  DEFAULT_METADATA,
  METADATA_PROMPT,
  assertUsableEmbedding,
  type EmbedderPing,
} from "./types.js";

export class OllamaEmbedder implements Embedder {
  private readonly endpoint: string;
  private readonly embedModel: string;
  private readonly llmModel: string;

  constructor() {
    this.endpoint = process.env.OLLAMA_ENDPOINT ?? "http://ollama-gpu-bridge:11434";
    this.embedModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    this.llmModel = process.env.OLLAMA_LLM_MODEL ?? "llama3.2";

    console.log(
      `[embedder] Ollama → ${this.endpoint} (embed: ${this.embedModel}, llm: ${this.llmModel})`
    );
  }

  /**
   * Cheap liveness probe: GET /api/tags lists installed models. No inference, no
   * model load, no cost -- ollama answers it from its own manifest.
   *
   * *** IT PROVES REACHABILITY, NOT CAPABILITY, AND THE DISTINCTION IS THE WHOLE
   * REASON ops-ob1.capability EXISTS SEPARATELY. *** A wedged runner answers
   * /api/tags perfectly while serving nothing (measured at S269). This makes the
   * container healthcheck able to fail at all -- it does not make it a substitute
   * for the real capability probe, and it must never be described as one.
   */
  async ping(): Promise<EmbedderPing> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return {
        provider: "ollama",
        reachable: res.ok,
        ms: Date.now() - started,
        detail: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        provider: "ollama",
        reachable: false,
        ms: Date.now() - started,
        detail: String((err as Error)?.message ?? err).slice(0, 120),
      };
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.embedModel, input: text, truncate: true }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.slice(0, 300).replace(/\s+/g, " ").trim();
      throw new Error(
        `Ollama embed failed: ${response.status} ${response.statusText}` +
          (snippet ? ` — ${snippet}` : "") +
          ` (content_bytes=${Buffer.byteLength(text, "utf8")})`
      );
    }

    const data = (await response.json()) as { embeddings?: number[][] };

    // S275: one shared guard for every provider. This path already refused an
    // empty vector; it did NOT check dimensionality or finiteness, and the other
    // two providers did not even check emptiness.
    return assertUsableEmbedding(data.embeddings?.[0], {
      model: this.embedModel,
      contentBytes: Buffer.byteLength(text, "utf8"),
    });
  }

  async extractMetadata(content: string): Promise<ThoughtMetadataExtracted> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.llmModel,
        messages: [
          { role: "system", content: METADATA_PROMPT },
          { role: "user", content },
        ],
        format: "json",
        stream: false,
      }),
    });

    if (!response.ok) {
      console.warn(`[embedder] Ollama metadata extraction failed: ${response.status}`);
      return DEFAULT_METADATA;
    }

    const data = (await response.json()) as { message: { content: string } };

    try {
      const parsed = JSON.parse(data.message.content) as ThoughtMetadataExtracted;
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
