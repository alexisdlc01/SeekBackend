import { Expose, Type } from "class-transformer";
import { IsEnum, ValidateNested } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { MessageType } from "../../conversation/message.schema";
import { UserDto } from "src/users/dto/user.dto";

export class MessageDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => UserDto)
	sender: UserDto;

	@ApiProperty({ enum: MessageType })
	@IsEnum(MessageType)
	@Expose()
	messageType: MessageType;

	@ApiProperty()
	@Expose()
	data: string;

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	conversation: string;

	@ApiProperty()
	@Expose()
	seenUsers: string[];

	@ApiProperty()
	@Expose()
	deliveredTo: string[];
}
