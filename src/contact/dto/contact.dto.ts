import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

export class ContactDto {
	@ApiProperty({ maxLength: 100 })
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	name: string;

	@ApiProperty({ maxLength: 254 })
	@IsEmail()
	@MaxLength(254)
	email: string;

	@ApiProperty({ maxLength: 5000 })
	@IsString()
	@MinLength(1)
	@MaxLength(5000)
	message: string;
}
