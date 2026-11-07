import { GeminiClient } from "./gemini.client";
import { LlmClient } from "./llm.client";

const config = (values: Record<string, string>) => ({ get: (key: string) => values[key] }) as any;

describe("LlmClient provider chain", () => {
	const messages = [{ role: "user" as const, content: "2-bed in Cotham" }];
	const realFetch = global.fetch;
	afterEach(() => {
		global.fetch = realFetch;
	});

	it("calls Gemini generateContent in JSON mode with the key as a header", async () => {
		const fetchMock = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
		});
		global.fetch = fetchMock as any;
		const gemini = new GeminiClient(config({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-test" }));
		const anthropic = { isConfigured: () => true, complete: jest.fn() };
		const answer = await new LlmClient(gemini, anthropic as any).complete({ system: "s", messages });

		expect(answer).toEqual({ text: '{"ok":true}', provider: "gemini" });
		expect(anthropic.complete).not.toHaveBeenCalled();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
		expect(init.headers["x-goog-api-key"]).toBe("k");
		expect(JSON.parse(init.body).generationConfig.responseMimeType).toBe("application/json");
	});

	it("falls back to Anthropic when Gemini fails, then to null", async () => {
		global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any;
		const gemini = new GeminiClient(config({ GEMINI_API_KEY: "k" }));
		const anthropic = { isConfigured: () => true, complete: jest.fn().mockResolvedValueOnce("{}").mockResolvedValueOnce(null) };
		const chain = new LlmClient(gemini, anthropic as any);

		expect(await chain.complete({ system: "s", messages })).toEqual({ text: "{}", provider: "anthropic" });
		expect(await chain.complete({ system: "s", messages })).toBeNull();
	});

	it("falls back to GEMINI_FALLBACK_MODEL on 429 and skips the exhausted model afterwards", async () => {
		const ok = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }) };
		const fetchMock = jest.fn()
			.mockResolvedValueOnce({ ok: false, status: 429 })
			.mockResolvedValue(ok);
		global.fetch = fetchMock as any;
		const gemini = new GeminiClient(config({ GEMINI_API_KEY: "k", GEMINI_MODEL: "primary" }));

		expect(await gemini.complete({ system: "s", messages })).toEqual({ text: "{}", model: "gemini-flash-lite-latest" });
		expect(await gemini.complete({ system: "s", messages })).toEqual({ text: "{}", model: "gemini-flash-lite-latest" });
		const urls = fetchMock.mock.calls.map(([url]) => url as string);
		expect(urls.filter(url => url.includes("/primary:")).length).toBe(1);
		expect(urls.length).toBe(3);
	});

	it("shares one 8 s budget across the whole chain instead of 15 s per provider", async () => {
		const budget = new AbortController();
		const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
		// The first model hangs until the budget runs out.
		const fetchMock = jest.fn((_url: string, init: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
				budget.abort();
			})
		);
		global.fetch = fetchMock as any;
		const anthropic = { isConfigured: () => true, complete: jest.fn() };
		const chain = new LlmClient(new GeminiClient(config({ GEMINI_API_KEY: "k" })), anthropic as any);

		try {
			expect(await chain.complete({ system: "s", messages })).toBeNull();
			expect(timeout.mock.calls).toEqual([[8000]]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(anthropic.complete).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it("is not configured without any key", () => {
		const chain = new LlmClient(new GeminiClient(config({})), { isConfigured: () => false } as any);
		expect(chain.isConfigured()).toBe(false);
	});
});
