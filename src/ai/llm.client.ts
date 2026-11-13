import { Injectable, Logger } from "@nestjs/common";
import { AnthropicClient, ChatTurn } from "./anthropic.client";
import { GeminiClient } from "./gemini.client";

export type LlmProvider = "gemini" | "anthropic";

/** Whole-chain budget: past it the caller's rule-based answer is used instead of waiting on each provider. */
const CHAIN_BUDGET_MS = 8_000;

/** A PDF or image sent with the first user turn (base64, no data: prefix). */
export interface LlmFile {
	mimeType: string;
	data: string;
}

export interface LlmAnswer {
	text: string;
	provider: LlmProvider;
}

/**
 * Provider chain: Gemini GEMINI_MODEL, then GEMINI_FALLBACK_MODEL (both with
 * GEMINI_API_KEY; a model that hit its quota is skipped for 10 minutes), then Anthropic
 * (ANTHROPIC_API_KEY). Returns null when neither is set or both fail, and the
 * caller falls back to its rule-based answer. Logs the provider that
 * answered, never a key.
 */
@Injectable()
export class LlmClient {
	private readonly logger = new Logger(LlmClient.name);

	constructor(
		private readonly gemini: GeminiClient,
		private readonly anthropic: AnthropicClient
	) {}

	isConfigured(): boolean {
		return this.gemini.isConfigured() || this.anthropic.isConfigured();
	}

	async complete(params: {
		system: string;
		messages: ChatTurn[];
		maxTokens?: number;
		responseSchema?: Record<string, unknown>;
		file?: LlmFile;
		/** Background callers (document review) can wait longer than a user-facing request. */
		budgetMs?: number;
	}): Promise<LlmAnswer | null> {
		const signal = AbortSignal.timeout(params.budgetMs ?? CHAIN_BUDGET_MS);
		if (this.gemini.isConfigured()) {
			const answer = await this.gemini.complete({ ...params, signal });
			if (answer) {
				this.logger.log(`AI provider: gemini (${answer.model})`);
				return { text: answer.text, provider: "gemini" };
			}
		}
		if (this.anthropic.isConfigured() && !signal.aborted) {
			const text = await this.anthropic.complete({ ...params, signal });
			if (text) {
				this.logger.log("AI provider: anthropic");
				return { text, provider: "anthropic" };
			}
		}
		return null;
	}
}
