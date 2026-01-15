import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class ResolveFlagDto {
	@ApiProperty()
	@IsString()
	status: string;
}
