import { Controller, Get, Query } from "@nestjs/common";
import { UploadService } from "./upload.service";
import { LandlordAgency } from "../auth/decorators/role-auth.decorator";

@Controller("upload")
export class UploadController {
	constructor(private readonly uploadService: UploadService) {}

	@Get("presign")
	@LandlordAgency()
	async getPresignedUrl(
		@Query("filename") filename: string,
		@Query("fileType") fileType: string,
		@Query("folder") folder: "public" | "private"
	) {
		return await this.uploadService.getPresignedUploadUrl(
			filename,
			fileType,
			folder
		);
	}

	@Get("access")
	@LandlordAgency()
	async download(@Query("key") key: string) {
		return this.uploadService.getPresignedDownloadUrl(key, "private");
	}
}
