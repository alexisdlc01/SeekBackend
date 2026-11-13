import { UsersRepository } from "./users.repository";

describe("UsersRepository.consumePasswordReset", () => {
	it("marks the address verified, so a squatted unverified signup is freed", async () => {
		const findOneAndUpdate = jest.fn().mockResolvedValue({ _id: "u1" });
		const repo = new UsersRepository({ findOneAndUpdate } as never);

		await expect(repo.consumePasswordReset("u1", "token-hash", "pw-hash")).resolves.toBe(true);

		const update = findOneAndUpdate.mock.calls[0][1];
		expect(update.$set).toEqual(
			expect.objectContaining({ password: "pw-hash", isVerified: true, refreshSessions: [] })
		);
	});

	it("clears the team only when asked (unproven account)", async () => {
		const findOneAndUpdate = jest.fn().mockResolvedValue({ _id: "u1" });
		const repo = new UsersRepository({ findOneAndUpdate } as never);

		await repo.consumePasswordReset("u1", "t", "p");
		await repo.consumePasswordReset("u1", "t", "p", true);

		expect(findOneAndUpdate.mock.calls[0][1].$set.team).toBeUndefined();
		expect(findOneAndUpdate.mock.calls[1][1].$set.team).toEqual([]);
	});
});

describe("UsersRepository.findTeamOwner", () => {
	it("never resolves a suspended owner, so their team cannot act for them", async () => {
		const findOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
		const repo = new UsersRepository({ findOne } as never);

		await expect(repo.findTeamOwner("m1" as never)).resolves.toBeNull();
		expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ suspendedAt: null, deletedAt: null }));
	});
});
