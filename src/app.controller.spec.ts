import { ServiceUnavailableException } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

describe("AppController", () => {
	let appController: AppController;
	const connection = { readyState: 1 };

	beforeEach(async () => {
		connection.readyState = 1;
		const app: TestingModule = await Test.createTestingModule({
			controllers: [AppController],
			providers: [
				AppService,
				{ provide: getConnectionToken(), useValue: connection }
			]
		}).compile();

		appController = app.get<AppController>(AppController);
	});

	describe("root", () => {
		it('should return "Hello World!"', () => {
			expect(appController.getHello()).toBe("Hello World!");
		});
	});

	describe("health", () => {
		it("returns ok when Mongo is connected", () => {
			expect(appController.health()).toEqual({ status: "ok" });
		});

		it("throws 503 down when Mongo is not connected", () => {
			connection.readyState = 0;
			expect(() => appController.health()).toThrow(ServiceUnavailableException);
			try {
				appController.health();
			} catch (e) {
				expect((e as ServiceUnavailableException).getResponse()).toEqual({
					status: "down"
				});
			}
		});
	});
});
