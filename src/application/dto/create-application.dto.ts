import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

export class CreateApplicationDto {
	@ApiProperty()
	@IsString()
	listingId: string;
}
