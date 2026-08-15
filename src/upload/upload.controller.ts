import { Controller, Get, Query } from "@nestjs/common";
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
	@StudentOrLandlord()
	async getPresignedUrl(
		@Query() { filename, fileType, folder }: PresignReqDto
	) {
		return await this.uploadService.getPresignedUploadUrl(
			filename,
			fileType,
			folder
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
