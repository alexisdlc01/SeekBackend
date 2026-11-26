import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { InventoryDto } from "./contract-extras.dto";

describe("InventoryDto", () => {
	it("refuses an empty inventory, which would wipe the saved one and tell tenants \"0 items recorded\"", async () => {
		expect(await validate(plainToInstance(InventoryDto, { items: [] }))).not.toHaveLength(0);
	});

	it("accepts one complete item", async () => {
		const items = [{ room: "Bedroom 2", item: "Mattress", condition: "Good" }];
		expect(await validate(plainToInstance(InventoryDto, { items }))).toHaveLength(0);
	});
});
