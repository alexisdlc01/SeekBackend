import { ApiProperty } from "@nestjs/swagger";
import { IsMongoId } from "class-validator";

export class ResendOtpDto {
	@ApiProperty()
	@IsMongoId()
	userId: string;
}
