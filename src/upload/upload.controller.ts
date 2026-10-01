import { Controller, Get, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UploadService } from "./upload.service";
import { LandlordAgency } from "../auth/decorators/role-auth.decorator";
import { ApiAccessDocs, ApiPresignDocs } from "./upload-swagger.decorator";
import { PresignReqDto } from "./dto/presign.dto";
import { AccessReqDto } from "./dto/access.dto";
import { StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";

@Controller("upload")
export class UploadController {
	constructor(private readonly uploadService: UploadService) { }

	@ApiPresignDocs()
	@Get("presign")
	@Throttle({ default: { limit: 20, ttl: 60_000 } })
	@StudentOrLandlord()
	async getPresignedUrl(
		@Query() { fileType, folder, fileSize }: PresignReqDto,
		@CurrentUser() user: User
	) {
		return await this.uploadService.getPresignedUploadUrl(
			fileType,
			folder,
			user._id.toString(),
			fileSize
		);
	}

	@ApiAccessDocs()
	@Get("access")
	@LandlordAgency()
	async download(
		@Query() { key }: AccessReqDto,
		@CurrentUser() user: User
	) {
		return this.uploadService.getAuthorizedPrivateDownloadUrl(key, user);
	}
}
