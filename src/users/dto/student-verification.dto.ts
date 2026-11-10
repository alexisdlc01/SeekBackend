import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, Matches, MaxLength } from "class-validator";

export class StudentEmailDto {
	@ApiProperty({ example: "abc12@st-andrews.ac.uk", description: "University address. Only @st-andrews.ac.uk for now." })
	@IsEmail()
	@MaxLength(254)
	email: string;
}

export class StudentEmailCodeDto {
	@ApiProperty({ example: "123456" })
	@Matches(/^\d{6}$/, { message: "Enter the 6-digit code." })
	code: string;
}

export class StudentVerificationResultDto {
	@ApiProperty()
	studentVerified: boolean;

	@ApiProperty({ example: "University of St Andrews" })
	university: string;
}
