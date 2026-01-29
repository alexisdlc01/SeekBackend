import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";
import { Listing } from "../../listings/listings.schema";
import { Conversation } from "../../conversation/converstaion.schema";
import { ApplicationStage } from "../enums/application-stage.enum";

export class ApplicationDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	listing: Listing;

	@ApiProperty({ type: Conversation })
	@Expose()
	conversation: Conversation;

	@ApiProperty()
	@Expose()
	landlord: string;

	@ApiProperty({ isArray: true, type: String })
	@Expose()
	applicants: string[];

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty({ enum: ApplicationStage })
	@Expose()
	stage: ApplicationStage;
}
