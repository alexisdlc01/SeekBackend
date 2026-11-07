import { ApiProperty } from "@nestjs/swagger";
import { Listing } from "../listings.schema";

export class ListingSearchResultDto extends Listing {
	@ApiProperty({ nullable: true, type: Number, example: 51.4655 })
	lat: number | null;

	@ApiProperty({ nullable: true, type: Number, example: -2.6005 })
	lng: number | null;

	@ApiProperty({
		nullable: true,
		type: Number,
		description: "monthlyRent divided by numOfPeople, in pounds."
	})
	rentPerPerson: number | null;
}
