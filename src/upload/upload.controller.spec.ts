import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Types } from "mongoose";
import { RoleGuard } from "../auth/guards/role.guard";
import { AccessControlService } from "../shared/access-control.service";
import { Role } from "../auth/role.enum";
import { TeamScope } from "../users/types/team-scope";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";

describe("UploadController", () => {
	it("authorizes private downloads through the resource-aware service", async () => {
		const uploadService = {
			getAuthorizedPrivateDownloadUrl: jest.fn()
				.mockResolvedValue("https://signed.example/file")
		} as unknown as UploadService;
		const controller = new UploadController(uploadService);
		const user = { _id: new Types.ObjectId() } as any;

		await expect(controller.download(
			{ key: "private/document.pdf" },
			user
		)).resolves.toBe("https://signed.example/file");
		expect(uploadService.getAuthorizedPrivateDownloadUrl)
			.toHaveBeenCalledWith("private/document.pdf", user);
	});

	it("mints a team member's upload under the owner, the id the consuming endpoints check", async () => {
		const owner = { _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY };
		const member = {
			_id: new Types.ObjectId(),
			role: Role.LANDLORD_AGENCY,
			teamMembership: { owner, scopes: [TeamScope.TENANCIES] }
		};
		const request = { user: member };
		const context = {
			getHandler: () => UploadController.prototype.getPresignedUrl,
			getClass: () => UploadController,
			switchToHttp: () => ({ getRequest: () => request })
		} as unknown as ExecutionContext;
		expect(new RoleGuard(new Reflector(), new AccessControlService()).canActivate(context)).toBe(true);

		const uploadService = { getPresignedUploadUrl: jest.fn().mockResolvedValue({}) } as unknown as UploadService;
		await new UploadController(uploadService).getPresignedUrl(
			{ fileType: "application/pdf", folder: "private", fileSize: 10 } as any,
			request.user as any
		);
		expect(uploadService.getPresignedUploadUrl).toHaveBeenCalledWith("application/pdf", "private", owner._id.toString(), 10);
	});
});
