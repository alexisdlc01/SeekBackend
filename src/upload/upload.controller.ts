import { ANY_TEAM_SCOPE, TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Controller, Get, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UploadService } from "./upload.service";
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
	// Team members mint under their owner, the id the contract/tenancy/listing endpoints check keys against.
	@TeamAccess(...ANY_TEAM_SCOPE)
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
	@TeamAccess(TeamScope.APPLICATIONS, TeamScope.VIEWINGS_INBOX, TeamScope.TENANCIES)
	@Get("access")
	@StudentOrLandlord()
	async download(
		@Query() { key }: AccessReqDto,
		@CurrentUser() user: User
	) {
		return this.uploadService.getAuthorizedPrivateDownloadUrl(key, user);
	}
}
