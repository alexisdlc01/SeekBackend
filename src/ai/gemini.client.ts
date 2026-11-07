import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChatTurn } from "./anthropic.client";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
/** Override with GEMINI_MODEL in .env. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
/** Tried when the primary model fails; override with GEMINI_FALLBACK_MODEL. */
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-flash-lite-latest";
/** A model that answered 429 (quota exhausted) is skipped for this long. */
const EXHAUSTED_COOLDOWN_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15_000;
// Gemini counts its thinking tokens against maxOutputTokens; without headroom the JSON answer is cut off.
const THINKING_HEADROOM = 2048;

/**
 * Thin wrapper over the Gemini generateContent REST API using fetch. Asks for
 * JSON output; returns null on any failure so callers fall back to the next
 * provider or the rule-based answer. The key is sent as a header and never
 * logged.
 */
@Injectable()
export class GeminiClient {
	private readonly logger = new Logger(GeminiClient.name);

	/** Model name -> time until which it is skipped after a 429. Per process. */
	private readonly exhaustedUntil = new Map<string, number>();

	constructor(private readonly config: ConfigService) {}

	isConfigured(): boolean {
		return Boolean(this.config.get<string>("GEMINI_API_KEY")?.trim());
	}

	/** Primary then fallback model, without duplicates. */
	models(): string[] {
		const primary = this.config.get<string>("GEMINI_MODEL")?.trim() || DEFAULT_GEMINI_MODEL;
		const fallback = this.config.get<string>("GEMINI_FALLBACK_MODEL")?.trim() || DEFAULT_GEMINI_FALLBACK_MODEL;
		return [...new Set([primary, fallback])];
	}

	/** Tries each model in turn, skipping any still cooling down after a 429. */
	async complete(params: {
		system: string;
		messages: ChatTurn[];
		maxTokens?: number;
		responseSchema?: Record<string, unknown>;
		signal?: AbortSignal;
	}): Promise<{ text: string; model: string } | null> {
		const apiKey = this.config.get<string>("GEMINI_API_KEY")?.trim();
		if (!apiKey) return null;

		// Gemini wants alternating user/model turns starting with the user.
		const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
		for (const message of params.messages) {
			const role = message.role === "assistant" ? "model" : "user";
			const last = contents[contents.length - 1];
			if (last && last.role === role) last.parts[0].text = `${last.parts[0].text}\n\n${message.content}`;
			else contents.push({ role, parts: [{ text: message.content }] });
		}
		while (contents.length && contents[0].role !== "user") contents.shift();
		if (!contents.length) return null;

		for (const model of this.models()) {
			if (params.signal?.aborted) break;
			if ((this.exhaustedUntil.get(model) ?? 0) > Date.now()) continue;
			const text = await this.call(model, apiKey, params, contents);
			if (text) return { text, model };
		}
		return null;
	}

	private async call(
		model: string,
		apiKey: string,
		params: { system: string; maxTokens?: number; responseSchema?: Record<string, unknown>; signal?: AbortSignal },
		contents: { role: "user" | "model"; parts: { text: string }[] }[]
	): Promise<string | null> {
		try {
			const response = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
				body: JSON.stringify({
					systemInstruction: { parts: [{ text: params.system }] },
					contents,
					generationConfig: {
						temperature: 0,
						maxOutputTokens: (params.maxTokens ?? 600) + THINKING_HEADROOM,
						responseMimeType: "application/json",
						...(params.responseSchema ? { responseSchema: params.responseSchema } : {})
					}
				}),
				signal: params.signal ?? AbortSignal.timeout(TIMEOUT_MS)
			});
			if (!response.ok) {
				if (response.status === 429) this.exhaustedUntil.set(model, Date.now() + EXHAUSTED_COOLDOWN_MS);
				this.logger.warn(`Gemini ${model} answered ${response.status}${response.status === 429 ? " (quota exhausted, skipped for 10 minutes)" : ""}; trying the next model or provider.`);
				return null;
			}
			const data = (await response.json()) as {
				candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
			};
			const finishReason = data.candidates?.[0]?.finishReason;
			if (finishReason && finishReason !== "STOP") {
				this.logger.warn(`Gemini ${model} stopped early (${finishReason}); trying the next model or provider.`);
				return null;
			}
			const text = (data.candidates?.[0]?.content?.parts ?? [])
				.filter(part => typeof part.text === "string" && !part.thought)
				.map(part => part.text)
				.join("")
				.trim();
			return text || null;
		} catch (error) {
			this.logger.warn(`Gemini ${model} call failed (${(error as Error).name}); trying the next model or provider.`);
			return null;
		}
	}
}
