import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class ConversationDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	name: string;

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	groupDescription: string;

	@ApiProperty()
	@Expose()
	avatar?: string;

	@ApiProperty()
	@Expose()
	users: string[];
}
