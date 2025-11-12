import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

class LoginDto {
	@ApiProperty()
	@IsString()
	email: string;

	@ApiProperty()
	@IsString()
	password: string;
}

export default LoginDto;
