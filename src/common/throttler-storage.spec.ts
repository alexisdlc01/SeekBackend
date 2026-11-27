import { ThrottlerStorageService } from "@nestjs/throttler";

// Regression: in @nestjs/throttler 6.4.0 a block expiring for one key cancelled the
// decrement timers of every other key of the same throttler, so their hits never decayed.
describe("ThrottlerStorageService (per-key hit expiry)", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it("a block expiring on key B does not freeze the hit count of key A", async () => {
		const storage = new ThrottlerStorageService();
		const ttl = 5000;
		const hit = (key: string) => storage.increment(key, ttl, 1, 1000, "default");

		await hit("B");
		expect((await hit("B")).isBlocked).toBe(true);
		await hit("A");
		await hit("A");

		jest.advanceTimersByTime(1100); // B's block expires
		expect((await hit("B")).totalHits).toBe(1); // B restarts: the 6.4.0 bug wiped A's timers here

		jest.advanceTimersByTime(ttl); // A's ttl has elapsed
		expect((await hit("A")).totalHits).toBe(1); // 6.4.0 would give 3

		storage.onApplicationShutdown();
	});
});
