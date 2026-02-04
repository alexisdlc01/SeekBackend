import { ApiProperty } from "@nestjs/swagger";
import { Expose, Transform, Type } from "class-transformer";
import { IsOptional, ValidateNested } from "class-validator";
import { MessageDto } from "src/message/dto/message.dto";
import { UserDto } from "src/users/dto/user.dto";

export class ConversationDto {
	@ApiProperty()
	@Expose()
	@Transform(({ obj }) => obj?._id.toString())
	_id: string;

	@ApiProperty()
	@Expose()
	name: string;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	lastMessage?: MessageDto;

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	groupDescription: string;

	@ApiProperty()
	@Expose()
	avatar?: string;

	@ApiProperty({ type: UserDto, isArray: true })
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => UserDto)
	users: UserDto[];

	@ApiProperty({ type: MessageDto, isArray: true })
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => MessageDto)
	messages: MessageDto[] = [];
}
