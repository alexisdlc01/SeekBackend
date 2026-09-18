import { IsMongoId, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class VerifyEmailDto {
	@ApiProperty()
	@IsString()
	token: string;

	@ApiProperty()
	@IsMongoId()
	userId: string;
}
