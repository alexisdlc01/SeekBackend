import { plainToInstance } from "class-transformer";
import { Types } from "mongoose";
import { ApplicationDto } from "./dto/application.dto";

describe("ApplicationDto listing ids", () => {
	it("keeps listing.landlord and requirement ids stable", () => {
		const landlord = new Types.ObjectId();
		const reqId = new Types.ObjectId();
		const value = {
			_id: new Types.ObjectId(),
			listing: { _id: new Types.ObjectId(), landlord, requirements: [{ _id: reqId, name: "a", desc: "b", required: true }] }
		};
		const dto = plainToInstance(ApplicationDto, value, { excludeExtraneousValues: true }) as any;
		expect(String(dto.listing.landlord)).toBe(landlord.toHexString());
		expect(String(dto.listing.requirements[0]._id)).toBe(reqId.toHexString());
	});
});
