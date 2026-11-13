import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ChatTurn {
	role: "user" | "assistant";
	content: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 15_000;
/** File types the Messages API reads; anything else (e.g. HEIC) is left to Gemini. */
const FILE_BLOCKS: Record<string, "document" | "image"> = {
	"application/pdf": "document",
	"image/jpeg": "image",
	"image/png": "image",
	"image/gif": "image",
	"image/webp": "image"
};

/**
 * Thin wrapper over the Anthropic Messages API using fetch. Returns null on
 * any failure so callers can fall back to the rule-based answer; the key is
 * never logged.
 */
@Injectable()
export class AnthropicClient {
	private readonly logger = new Logger(AnthropicClient.name);

	constructor(private readonly config: ConfigService) {}

	isConfigured(): boolean {
		return Boolean(this.config.get<string>("ANTHROPIC_API_KEY")?.trim());
	}

	async complete(params: { system: string; messages: ChatTurn[]; maxTokens?: number; signal?: AbortSignal; file?: { mimeType: string; data: string } }): Promise<string | null> {
		const apiKey = this.config.get<string>("ANTHROPIC_API_KEY")?.trim();
		if (!apiKey) return null;
		const fileBlock = params.file ? FILE_BLOCKS[params.file.mimeType] : undefined;
		if (params.file && !fileBlock) return null;

		// The API needs the conversation to start with a user turn and to
		// alternate; merge consecutive turns from the same side.
		const turns: ChatTurn[] = [];
		for (const message of params.messages) {
			const last = turns[turns.length - 1];
			if (last && last.role === message.role) {
				last.content = `${last.content}\n\n${message.content}`;
			} else {
				turns.push({ ...message });
			}
		}
		while (turns.length && turns[0].role !== "user") turns.shift();
		if (!turns.length) return null;

		try {
			const response = await fetch(ANTHROPIC_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01"
				},
				body: JSON.stringify({
					model: this.config.get<string>("ANTHROPIC_MODEL")?.trim() || DEFAULT_MODEL,
					max_tokens: params.maxTokens ?? 600,
					temperature: 0,
					system: params.system,
					messages: params.file
						? turns.map((turn, index) => index === 0
							? { role: turn.role, content: [{ type: fileBlock, source: { type: "base64", media_type: params.file!.mimeType, data: params.file!.data } }, { type: "text", text: turn.content }] }
							: turn)
						: turns
				}),
				signal: params.signal ?? AbortSignal.timeout(TIMEOUT_MS)
			});
			if (!response.ok) {
				this.logger.warn(`Anthropic API answered ${response.status}; using the rule-based fallback.`);
				return null;
			}
			const data = (await response.json()) as { content?: { type: string; text?: string }[] };
			const text = (data.content ?? [])
				.filter(block => block.type === "text" && typeof block.text === "string")
				.map(block => block.text)
				.join("")
				.trim();
			return text || null;
		} catch (error) {
			this.logger.warn(`Anthropic API call failed (${(error as Error).name}); using the rule-based fallback.`);
			return null;
		}
	}
}
