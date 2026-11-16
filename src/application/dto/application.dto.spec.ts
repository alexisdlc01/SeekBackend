import { plainToInstance } from "class-transformer";
import { Types } from "mongoose";
import { ApplicationDto } from "./application.dto";

describe("ApplicationDto", () => {
	it("exposes offerExpiredAt so clients can tell a lapsed offer from a fresh household", () => {
		const lapsed = new Date("2026-01-01T00:00:00Z");
		const dto = plainToInstance(ApplicationDto, { _id: new Types.ObjectId(), offerExpiredAt: lapsed }, { excludeExtraneousValues: true });
		expect(dto.offerExpiredAt).toEqual(lapsed);
	});
});
