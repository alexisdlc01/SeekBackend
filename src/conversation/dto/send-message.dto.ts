import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class SendMessageDto {
	@ApiProperty({ maxLength: 5000 })
	@IsString()
	@IsNotEmpty()
	@MaxLength(5000)
	message: string;
}
