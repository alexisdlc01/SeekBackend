import { Expose, Transform, Type } from "class-transformer";
import { IsEnum, ValidateNested } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { MessageType } from "../../conversation/message.schema";
import { UserDto } from "src/users/dto/user.dto";
import { ObjectIdString } from "src/shared/object-id.transform";

export class MessageDto {
	@ApiProperty()
	@Expose()
	@Transform(({ obj }) => obj?._id.toString())
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
	@ObjectIdString()
	conversation: string;

	@ApiProperty()
	@Expose()
	@ObjectIdString()
	seenUsers: string[];

	@ApiProperty()
	@Expose()
	@ObjectIdString()
	deliveredTo: string[];
}
