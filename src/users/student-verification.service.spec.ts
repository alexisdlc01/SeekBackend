import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { Types } from "mongoose";
import { StudentVerificationService, universityForEmail } from "./student-verification.service";
import { UserDto } from "./dto/user.dto";

// One stored student; the fake model applies just the operators the service uses.
function setup(otherVerified: string[] = []) {
	const userId = new Types.ObjectId();
	const doc: Record<string, any> = { _id: userId, name: "Sam", role: "STUDENT" };
	const apply = (update: any) => {
		Object.assign(doc, update.$set ?? {});
		for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
		for (const [key, by] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + (by as number);
	};
	const userModel = {
		updateOne: jest.fn(async (_query: unknown, update: any) => apply(update)),
		exists: jest.fn(async (query: any) => (otherVerified.includes(query.universityEmail) ? { _id: new Types.ObjectId() } : null)),
		findOneAndUpdate: jest.fn((filter: any, update: any) => {
			const live = doc.studentEmailCodeExpires > filter.studentEmailCodeExpires.$gt
				&& (doc.studentEmailAttempts ?? 0) < filter.studentEmailAttempts.$lt;
			if (live) apply(update);
			const result = live ? { ...doc } : null;
			return { select: () => ({ lean: () => ({ exec: async () => result }) }) };
		})
	};
	const mailService = { sendStudentVerificationCode: jest.fn().mockResolvedValue(undefined) };
	const service = new StudentVerificationService(userModel as any, mailService as any);
	const sentCode = () => mailService.sendStudentVerificationCode.mock.calls.at(-1)![1] as string;
	const wrong = (code: string) => (code === "000000" ? "111111" : "000000");
	return { service, userId, doc, mailService, sentCode, wrong };
}

describe("universityForEmail", () => {
	it.each([
		["ab12@st-andrews.ac.uk", "University of St Andrews"],
		["  AB12@St-Andrews.AC.UK ", "University of St Andrews"],
		["ab12@cs.st-andrews.ac.uk", null],
		["ab12@st-andrews.ac.uk.evil.com", null],
		["ab12@gmail.com", null],
		["ab12@constructor", null],
		["@st-andrews.ac.uk", null]
	])("%s -> %s", (email, expected) => {
		expect(universityForEmail(email)).toBe(expected);
	});
});

describe("StudentVerificationService", () => {
	it("rejects a non St Andrews domain without sending anything", async () => {
		const { service, userId, mailService } = setup();
		await expect(service.sendCode(userId, "sam@ed.ac.uk")).rejects.toBeInstanceOf(BadRequestException);
		expect(mailService.sendStudentVerificationCode).not.toHaveBeenCalled();
	});

	it("answers a taken address like any other, then refuses it at verify with a generic 400", async () => {
		const { service, userId, doc, sentCode, mailService } = setup(["ab12@st-andrews.ac.uk"]);
		await expect(service.sendCode(userId, "AB12@st-andrews.ac.uk")).resolves.toBeUndefined();
		expect(mailService.sendStudentVerificationCode).toHaveBeenCalledWith("ab12@st-andrews.ac.uk", expect.stringMatching(/^\d{6}$/));
		const refused = service.verify(userId, sentCode());
		await expect(refused).rejects.toBeInstanceOf(BadRequestException);
		await expect(refused).rejects.not.toThrow(/another/i);
		expect(doc.studentVerifiedAt).toBeUndefined();
		expect(doc).not.toHaveProperty("studentEmailPending");
	});

	it("stores only a hash of a 6-digit code with a 15-minute expiry", async () => {
		const { service, userId, doc, sentCode, mailService } = setup();
		await service.sendCode(userId, " AB12@st-andrews.ac.uk ");
		expect(mailService.sendStudentVerificationCode).toHaveBeenCalledWith("ab12@st-andrews.ac.uk", expect.stringMatching(/^\d{6}$/));
		expect(doc.studentEmailCodeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(doc.studentEmailCodeHash).not.toContain(sentCode());
		const minutes = (doc.studentEmailCodeExpires.getTime() - Date.now()) / 60_000;
		expect(minutes).toBeGreaterThan(14.9);
		expect(minutes).toBeLessThanOrEqual(15);
	});

	it("refuses a wrong code and requires a new one after 5 attempts", async () => {
		const { service, userId, doc, sentCode, wrong } = setup();
		await service.sendCode(userId, "ab12@st-andrews.ac.uk");
		const code = sentCode();
		for (let i = 1; i <= 4; i++) {
			await expect(service.verify(userId, wrong(code))).rejects.toThrow(`${5 - i} attempt`);
		}
		await expect(service.verify(userId, wrong(code))).rejects.toThrow("no attempts left");
		// Even the right code is dead now.
		await expect(service.verify(userId, code)).rejects.toThrow("Request a new code");
		expect(doc.studentVerifiedAt).toBeUndefined();

		await service.sendCode(userId, "ab12@st-andrews.ac.uk");
		await expect(service.verify(userId, sentCode())).resolves.toEqual({ studentVerified: true, university: "University of St Andrews" });
	});

	it("refuses an expired code", async () => {
		const { service, userId, doc, sentCode } = setup();
		await service.sendCode(userId, "ab12@st-andrews.ac.uk");
		doc.studentEmailCodeExpires = new Date(Date.now() - 1);
		await expect(service.verify(userId, sentCode())).rejects.toBeInstanceOf(BadRequestException);
	});

	it("sets the badge on success and clears the code", async () => {
		const { service, userId, doc, sentCode } = setup();
		await service.sendCode(userId, "ab12@st-andrews.ac.uk");
		await service.verify(userId, sentCode());
		expect(doc).toMatchObject({ universityEmail: "ab12@st-andrews.ac.uk", university: "University of St Andrews" });
		expect(doc.studentVerifiedAt).toBeInstanceOf(Date);
		for (const key of ["studentEmailPending", "studentEmailCodeHash", "studentEmailCodeExpires", "studentEmailAttempts"]) {
			expect(doc).not.toHaveProperty(key);
		}
		const dto = plainToInstance(UserDto, doc, { excludeExtraneousValues: true });
		expect(dto).toMatchObject({ studentVerified: true, university: "University of St Andrews" });
		expect(dto).not.toHaveProperty("universityEmail");
	});

	it("profile DTO shows no badge for an unverified student", () => {
		const dto = plainToInstance(UserDto, { _id: new Types.ObjectId(), university: "University of St Andrews" }, { excludeExtraneousValues: true });
		expect(dto).toMatchObject({ studentVerified: false, university: null });
	});
});

it("UserDto keeps the badge when @Serialize transforms it a second time", () => {
	const once = plainToInstance(UserDto, { _id: new Types.ObjectId(), studentVerifiedAt: new Date(), university: "University of St Andrews" }, { excludeExtraneousValues: true });
	expect(plainToInstance(UserDto, once, { excludeExtraneousValues: true })).toMatchObject({ studentVerified: true, university: "University of St Andrews" });
});
