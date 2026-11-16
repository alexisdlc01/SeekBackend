import { ValidationPipe } from "@nestjs/common";
import { UpdateUserProfileDto } from "./update-user-profile.dto";

// Same options as src/main.ts: server-controlled flags can't ride along in a PATCH body.
describe("UpdateUserProfileDto", () => {
	const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
	const run = (body: object) => pipe.transform(body, { type: "body", metatype: UpdateUserProfileDto });

	it.each(["isVerified", "verified", "studentVerified", "studentVerifiedAt", "university", "universityEmail", "role"])("rejects %s in the body", async field => {
		await expect(run({ [field]: true })).rejects.toThrow();
	});

	// Only connectOnboard may bind a payout account; a PATCH could point payouts at someone else's acct_.
	it("rejects a stripeAccountId in the body", async () => {
		await expect(run({ stripeAccountId: "acct_1AbCdEfGhIjKlMn" })).rejects.toThrow();
	});

	it("still accepts a normal profile edit", async () => {
		await expect(run({ universityDetails: "UCL" })).resolves.toBeDefined();
	});
});
