import { Types } from "mongoose";
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
});
