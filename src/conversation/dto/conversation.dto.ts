import { ApiProperty } from "@nestjs/swagger";
import { Expose, Transform, Type } from "class-transformer";
import { IsOptional, ValidateNested } from "class-validator";
import { MessageDto } from "../../message/dto/message.dto";
import { PublicUserDto } from "../../users/dto/user.dto";

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
	@Type(() => MessageDto)
	lastMessage?: MessageDto;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	unreadCount?: number;

	@ApiProperty()
	@Expose()
	createdAt: Date;

	/** Set once the conversation is closed (application deleted, offer withdrawn...): sending is refused, so clients hide the composer. */
	@ApiProperty({ required: false })
	@Expose()
	closedAt?: Date;

	@ApiProperty()
	@Expose()
	groupDescription: string;

	@ApiProperty()
	@Expose()
	avatar?: string;

	@ApiProperty({ type: PublicUserDto, isArray: true })
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => PublicUserDto)
	users: PublicUserDto[];

	@ApiProperty({ type: MessageDto, isArray: true })
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => MessageDto)
	messages: MessageDto[] = [];
}
