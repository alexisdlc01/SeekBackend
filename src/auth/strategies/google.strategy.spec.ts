import { GoogleStrategy } from "./google.strategy";

describe("GoogleStrategy state (login CSRF)", () => {
	const config = { getOrThrow: (key: string) => key, get: () => "production" };
	const stateStore = () => (new GoogleStrategy(config as never) as any)._stateStore;

	it("issues a state bound to a cookie and accepts only the matching callback", () => {
		const store = stateStore();
		const res = { cookie: jest.fn(), clearCookie: jest.fn() };
		let issued = "";
		store.store({ res }, (_err: unknown, state: string) => { issued = state; });
		expect(issued).toMatch(/^[0-9a-f]{32}$/);
		expect(res.cookie).toHaveBeenCalledWith("GoogleOAuthState", issued, expect.objectContaining({ httpOnly: true, secure: true }));

		const verify = (cookie: string | undefined, state: string) => {
			let result: boolean | undefined;
			store.verify({ cookies: { GoogleOAuthState: cookie }, res }, state, (_e: unknown, ok: boolean) => { result = ok; });
			return result;
		};
		expect(verify(issued, issued)).toBe(true);
		// Attacker-forwarded callback: victim's browser has no (or another) state cookie.
		expect(verify(undefined, issued)).toBe(false);
		expect(verify("other", issued)).toBe(false);
		expect(verify(undefined, undefined as never)).toBe(false);
	});
});
