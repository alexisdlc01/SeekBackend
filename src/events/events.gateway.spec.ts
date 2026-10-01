import { Test, TestingModule } from "@nestjs/testing";
import { EventsGateway } from "./events.gateway";
import UsersService from "../users/users.service";

describe("EventsGateway", () => {
	let gateway: EventsGateway;

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			providers: [
				EventsGateway,
				{ provide: UsersService, useValue: {} }
			]
		}).compile();

		gateway = module.get<EventsGateway>(EventsGateway);
	});

	it("should be defined", () => {
		expect(gateway).toBeDefined();
	});

	it("registers socket authentication before any handler runs", () => {
		const use = jest.fn();
		gateway.afterInit({ use } as never);

		expect(use).toHaveBeenCalledTimes(1);
	});
});
