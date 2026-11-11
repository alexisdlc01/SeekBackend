import { Logger } from "@nestjs/common";
import { MailService } from "./mail.service";

const create = jest.fn().mockResolvedValue({});
jest.mock("mailgun.js", () => ({
	__esModule: true,
	default: jest.fn().mockImplementation(() => ({ client: () => ({ messages: { create } }) }))
}));

describe("MailService send gate", () => {
	const build = (env: Record<string, string | undefined>) =>
		new MailService({ getOrThrow: (key: string) => `${key}-value.example.org`, get: (key: string) => env[key] } as any);

	beforeEach(() => {
		create.mockClear();
		jest.spyOn(Logger.prototype, "log").mockImplementation();
	});

	it("does not call Mailgun in development without the flag", async () => {
		await build({ NODE_ENV: "development" }).sendOtpEmail("a@st-andrews.ac.uk", "123456");
		expect(create).not.toHaveBeenCalled();
	});

	it("calls Mailgun in development when MAIL_SEND_OUTSIDE_PRODUCTION is true", async () => {
		await build({ NODE_ENV: "development", MAIL_SEND_OUTSIDE_PRODUCTION: "true" }).sendOtpEmail("a@st-andrews.ac.uk", "123456");
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("calls Mailgun in production", async () => {
		await build({ NODE_ENV: "production" }).sendOtpEmail("a@st-andrews.ac.uk", "123456");
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("calls Mailgun when NODE_ENV is unset (fails open in production)", async () => {
		await build({}).sendOtpEmail("a@st-andrews.ac.uk", "123456");
		expect(create).toHaveBeenCalledTimes(1);
	});
});
