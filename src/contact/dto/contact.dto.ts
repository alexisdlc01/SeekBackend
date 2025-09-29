import {
	IsEmail,
	IsString
} from "class-validator";

export class ContactDto {
	@IsString()
	name: string;

	@IsEmail()
	email: string;

	@IsString()
	message: string;
}
