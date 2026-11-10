import { ValidationPipe } from "@nestjs/common";
import { UpdateUserProfileDto } from "./update-user-profile.dto";

// Same options as src/main.ts: server-controlled flags can't ride along in a PATCH body.
describe("UpdateUserProfileDto", () => {
	const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
	const run = (body: object) => pipe.transform(body, { type: "body", metatype: UpdateUserProfileDto });

	it.each(["isVerified", "verified", "studentVerified", "studentVerifiedAt", "university", "universityEmail", "role"])("rejects %s in the body", async field => {
		await expect(run({ [field]: true })).rejects.toThrow();
	});

	it("still accepts a normal profile edit", async () => {
		await expect(run({ universityDetails: "UCL" })).resolves.toBeDefined();
	});
});
