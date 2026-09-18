import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BrowserOriginGuard } from "./browser-origin.guard";

function contextFor(request: {
	method: string;
	headers: Record<string, string | undefined>;
}): ExecutionContext {
	return {
		getType: () => "http",
		switchToHttp: () => ({ getRequest: () => request })
	} as unknown as ExecutionContext;
}

describe("BrowserOriginGuard", () => {
	function guardFor(values: Record<string, unknown>) {
		return new BrowserOriginGuard({
			get: (key: string) => values[key]
		} as ConfigService);
	}

	it("allows non-HTTP transports", () => {
		const guard = guardFor({ NODE_ENV: "production" });
		const context = { getType: () => "ws" } as ExecutionContext;
		expect(guard.canActivate(context)).toBe(true);
	});

	it.each(["GET", "HEAD", "OPTIONS"])("allows safe %s requests", method => {
		const guard = guardFor({ NODE_ENV: "production" });
		expect(guard.canActivate(contextFor({ method, headers: {} }))).toBe(true);
	});

	it("allows unsafe requests from the configured browser origin", () => {
		const guard = guardFor({
			NODE_ENV: "production",
			FRONTEND_URL: "https://seek.example, https://admin.seek.example/"
		});
		expect(
			guard.canActivate(contextFor({
				method: "POST",
				headers: { origin: "https://admin.seek.example" }
			}))
		).toBe(true);
	});

	it("allows mobile requests that require the custom platform header", () => {
		const guard = guardFor({ NODE_ENV: "production" });
		expect(
			guard.canActivate(contextFor({
				method: "PATCH",
				headers: { platform: "mobile" }
			}))
		).toBe(true);
	});

	it("allows local unsafe requests outside production", () => {
		const guard = guardFor({ NODE_ENV: "development" });
		expect(
			guard.canActivate(contextFor({ method: "DELETE", headers: {} }))
		).toBe(true);
	});

	it.each([undefined, "https://evil.example"])(
		"rejects an unsafe production request from %s",
		origin => {
			const guard = guardFor({
				NODE_ENV: "production",
				FRONTEND_URL: "https://seek.example"
			});
			expect(() =>
				guard.canActivate(contextFor({
					method: "POST",
					headers: { origin }
				}))
			).toThrow(ForbiddenException);
		}
	);
});
