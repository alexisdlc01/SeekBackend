import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { ApplicationService } from "../application.service";
import { ApplicationOwnerGuard } from "./application-owner.guard";

function contextFor(userId: Types.ObjectId): ExecutionContext {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				user: { _id: userId },
				params: { id: new Types.ObjectId().toString() }
			})
		})
	} as unknown as ExecutionContext;
}

describe("ApplicationOwnerGuard", () => {
	it("accepts a Mongoose ObjectId owned by the authenticated user", async () => {
		const userId = new Types.ObjectId();
		const applicationService = {
			findApplicationById: jest.fn().mockResolvedValue({ owner: userId })
		} as unknown as ApplicationService;
		const guard = new ApplicationOwnerGuard(applicationService);

		await expect(guard.canActivate(contextFor(userId))).resolves.toBe(true);
	});

	it("rejects a different application owner", async () => {
		const applicationService = {
			findApplicationById: jest.fn().mockResolvedValue({
				owner: new Types.ObjectId()
			})
		} as unknown as ApplicationService;
		const guard = new ApplicationOwnerGuard(applicationService);

		await expect(
			guard.canActivate(contextFor(new Types.ObjectId()))
		).rejects.toBeInstanceOf(ForbiddenException);
	});
});
