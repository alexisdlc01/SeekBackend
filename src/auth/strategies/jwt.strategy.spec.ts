import { UnauthorizedException } from "@nestjs/common";
import { Types } from "mongoose";
import { Role } from "../role.enum";
import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
	const session = {
		sessionId: "session-a",
		tokenHash: "hash",
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		lastUsedAt: new Date()
	};
	const user = {
		_id: new Types.ObjectId(),
		email: "student@example.com",
		name: "Student",
		role: Role.STUDENT,
		isVerified: true,
		refreshSessions: [session]
	};

	it("accepts an access token only while its device session exists", async () => {
		const strategy = new JwtStrategy(
			{
				getOrThrow: jest.fn().mockReturnValue("secret"),
				get: jest.fn().mockReturnValue(false)
			} as never,
			{ getUserById: jest.fn().mockResolvedValue(user) } as never
		);

		await expect(strategy.validate({
			userId: user._id.toString(),
			sessionId: session.sessionId
		})).resolves.toEqual(expect.objectContaining({
			authSessionId: session.sessionId
		}));
	});

	it("rejects an access token after its session is revoked", async () => {
		const strategy = new JwtStrategy(
			{
				getOrThrow: jest.fn().mockReturnValue("secret"),
				get: jest.fn().mockReturnValue(false)
			} as never,
			{
				getUserById: jest.fn().mockResolvedValue({
					...user,
					refreshSessions: []
				})
			} as never
		);

		await expect(strategy.validate({
			userId: user._id.toString(),
			sessionId: session.sessionId
		})).rejects.toBeInstanceOf(UnauthorizedException);
	});
});
