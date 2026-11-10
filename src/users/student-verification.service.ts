import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { User } from "./users.schema";
import { MailService } from "../auth/mail.service";

/** Email domains that prove enrolment, and the university each one means. Exact match: no subdomains. */
export const STUDENT_EMAIL_DOMAINS = new Map<string, string>([
	["st-andrews.ac.uk", "University of St Andrews"]
]);

const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const PENDING_FIELDS = { studentEmailPending: 1, studentEmailCodeHash: 1, studentEmailCodeExpires: 1, studentEmailAttempts: 1 } as const;

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

export function universityForEmail(email: string): string | null {
	const parts = email.trim().toLowerCase().split("@");
	return parts.length === 2 && parts[0] ? STUDENT_EMAIL_DOMAINS.get(parts[1]) ?? null : null;
}

/** "Verified student" badge: the student proves a university address by receiving a code there. */
@Injectable()
export class StudentVerificationService {
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly mailService: MailService
	) { }

	async sendCode(userId: Types.ObjectId, email: string): Promise<void> {
		const address = email.trim().toLowerCase();
		if (!universityForEmail(address)) {
			const allowed = [...STUDENT_EMAIL_DOMAINS.keys()].map(domain => `@${domain}`).join(", ");
			throw new BadRequestException(`Only university addresses ending in ${allowed} can be verified for now.`);
		}
		// No "already taken" check here: a different answer would reveal which addresses have Seek accounts.
		// The code only reaches the inbox owner; /verify refuses a taken address generically.
		const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
		await this.userModel.updateOne({ _id: userId }, {
			$set: {
				studentEmailPending: address,
				studentEmailCodeHash: hashCode(code),
				studentEmailCodeExpires: new Date(Date.now() + CODE_TTL_MS),
				studentEmailAttempts: 0
			}
		});
		await this.mailService.sendStudentVerificationCode(address, code);
	}

	async verify(userId: Types.ObjectId, code: string): Promise<{ studentVerified: true; university: string }> {
		// Count the attempt before comparing, atomically, so parallel guesses can't exceed the limit.
		const user = await this.userModel
			.findOneAndUpdate(
				{ _id: userId, studentEmailCodeExpires: { $gt: new Date() }, studentEmailAttempts: { $lt: MAX_ATTEMPTS } },
				{ $inc: { studentEmailAttempts: 1 } },
				{ new: true }
			)
			.select("+studentEmailPending +studentEmailCodeHash +studentEmailAttempts")
			.lean()
			.exec();
		if (!user?.studentEmailPending || !user.studentEmailCodeHash) {
			throw new BadRequestException("This code has expired or was tried too many times. Request a new code.");
		}
		const expected = Buffer.from(user.studentEmailCodeHash, "hex");
		const actual = Buffer.from(hashCode(code.trim()), "hex");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			const left = MAX_ATTEMPTS - (user.studentEmailAttempts ?? MAX_ATTEMPTS);
			if (left <= 0) {
				await this.userModel.updateOne({ _id: userId }, { $unset: PENDING_FIELDS });
				throw new BadRequestException("Wrong code, and no attempts left. Request a new code.");
			}
			throw new BadRequestException(`Wrong code. ${left} attempt${left === 1 ? "" : "s"} left.`);
		}

		const address = user.studentEmailPending;
		const university = universityForEmail(address)!;
		if (await this.userModel.exists({ universityEmail: address, _id: { $ne: userId } })) {
			await this.userModel.updateOne({ _id: userId }, { $unset: PENDING_FIELDS });
			throw this.taken();
		}
		try {
			await this.userModel.updateOne({ _id: userId }, {
				$set: { universityEmail: address, university, studentVerifiedAt: new Date() },
				$unset: PENDING_FIELDS
			});
		} catch (error) {
			if ((error as { code?: number })?.code === 11000) throw this.taken();
			throw error;
		}
		return { studentVerified: true, university };
	}

	private taken() {
		return new BadRequestException("This university email can't be verified on this account. Contact support if you think this is wrong.");
	}
}
