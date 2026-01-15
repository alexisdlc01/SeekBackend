import { ApiProperty } from "@nestjs/swagger";
import { Listing } from "../listings.schema";

export class LikedListingsDto {
	@ApiProperty({ type: Listing, isArray: true })
	data: Listing[];

	@ApiProperty()
	total: number;
}
