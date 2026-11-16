import { ValidationPipe } from "@nestjs/common";
import { SetUsernameDto } from "./set-username.dto";

describe("SetUsernameDto", () => {
	const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
	const run = (body: object) => pipe.transform(body, { type: "body", metatype: SetUsernameDto });

	it.each(["", "   ", "x".repeat(81)])("rejects name %j", async name => {
		await expect(run({ name })).rejects.toThrow();
	});

	it("accepts a normal name", async () => {
		await expect(run({ name: "Alice Martin" })).resolves.toBeDefined();
	});
});
