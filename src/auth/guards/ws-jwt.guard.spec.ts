import { WsJwtGuard } from "./ws-jwt.guard";

describe("WsJwtGuard.extractToken", () => {
	const env = { ...process.env };
	const socket = (origin?: string) => ({
		handshake: { headers: { cookie: "Authentication=tok", ...(origin ? { origin } : {}) }, query: {} }
	}) as never;

	beforeEach(() => {
		process.env.NODE_ENV = "production";
		process.env.FRONTEND_URL = "https://www.seekapp.uk, https://seekapp.uk/";
	});
	afterAll(() => { process.env = env; });

	it("ignores the auth cookie on a cross-site handshake (CSWSH)", () => {
		expect(WsJwtGuard.extractToken(socket("https://evil.example"))).toBeNull();
		expect(WsJwtGuard.extractToken(socket())).toBeNull();
	});

	it("accepts the auth cookie from a configured front-end origin", () => {
		expect(WsJwtGuard.extractToken(socket("https://www.seekapp.uk"))).toBe("tok");
		expect(WsJwtGuard.extractToken(socket("https://seekapp.uk"))).toBe("tok");
	});
});
