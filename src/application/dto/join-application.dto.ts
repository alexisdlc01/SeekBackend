import { IsString, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class JoinApplicationDto {
	@ApiProperty({
		description:
			"Invite secret from the shared link. The application id alone does not authorize joining."
	})
	@IsString()
	@Length(64, 64)
	invite: string;
}
