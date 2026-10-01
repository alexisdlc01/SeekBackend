import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { ApplicationService } from "../application.service";
import { ApplicationStage } from "../enums/application-stage.enum";
import { ApplicationAdminGuard } from "./application-admin.guard";

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

function guardFor(application: Record<string, unknown>) {
	const applicationService = {
		findApplicationById: jest.fn().mockResolvedValue(application)
	} as unknown as ApplicationService;
	return new ApplicationAdminGuard(applicationService);
}

describe("ApplicationAdminGuard", () => {
	const owner = new Types.ObjectId();
	const landlord = new Types.ObjectId();

	it("accepts the application creator", async () => {
		const guard = guardFor({ owner, landlord, stage: ApplicationStage.NOT_SENT });

		await expect(guard.canActivate(contextFor(owner))).resolves.toBe(true);
	});

	it("accepts the landlord once the application has been sent", async () => {
		const guard = guardFor({ owner, landlord, stage: ApplicationStage.SENT });

		await expect(guard.canActivate(contextFor(landlord))).resolves.toBe(true);
	});

	it("rejects the landlord before the application reaches them", async () => {
		const guard = guardFor({ owner, landlord, stage: ApplicationStage.NOT_SENT });

		await expect(guard.canActivate(contextFor(landlord))).rejects.toBeInstanceOf(
			ForbiddenException
		);
	});

	it("rejects other members", async () => {
		const guard = guardFor({ owner, landlord, stage: ApplicationStage.SENT });

		await expect(
			guard.canActivate(contextFor(new Types.ObjectId()))
		).rejects.toBeInstanceOf(ForbiddenException);
	});
});
