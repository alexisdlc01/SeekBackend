import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Mailgun from "mailgun.js";
import { User } from "../users/users.schema";
import { FlagCategory } from "../flags/enums/category";

const formData = require("form-data");

/**
 * Escapes a value for interpolation into an HTML email body.
 *
 * Several of these messages carry text supplied by users — contact form
 * submissions, flag reports, display names — into an inbox that staff read and
 * trust. Without escaping, a sender can compose arbitrary markup inside a
 * message that appears to come from our own domain.
 */
function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

@Injectable()
export class MailService {
	private readonly logger = new Logger(MailService.name);
	private mail: any;
	private readonly domain: string;

	constructor(private readonly configService: ConfigService) {
		this.domain = this.configService.getOrThrow("MAILGUN_DOMAIN");
		// Sandbox domains only exist in Mailgun's US region, so they need api.mailgun.net.
		const url = this.domain.endsWith(".mailgun.org") ? "https://api.mailgun.net" : "https://api.eu.mailgun.net";
		const mailgun = new Mailgun(formData);
		this.mail = mailgun.client({
			username: "api",
			key: this.configService.getOrThrow("MAILGUN_API_KEY"),
			url
		});
	}

	/** Every e-mail goes through here: dev/test accounts use real addresses, so development and test skip sending unless explicitly opted in. */
	private async send(message: { subject: string; [key: string]: unknown }) {
		// Fails open: prod may not set NODE_ENV (npm run start:prod), so only dev/test skip.
		const env = this.configService.get("NODE_ENV");
		const skip = (env === "development" || env === "test") && this.configService.get("MAIL_SEND_OUTSIDE_PRODUCTION") !== "true";
		if (skip) {
			this.logger.log(`e-mail skipped (non-production): ${message.subject}`);
			return;
		}
		await this.mail.messages.create(this.domain, message);
	}

	async sendVerificationEmail(email: string, token: string, userId: string) {
		const link: string = `${this.configService.getOrThrow("FRONTEND_URL")}/verify-email?token=${token}&userId=${userId}`;

		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Verify your email",
			text: `Click this link to verify your email: ${link}`,
			html: `<p>Click <a href="${escapeHtml(link)}">here</a> to verify your email address.</p>`
		});
	}

	async sendOtpEmail(email: string, otp: string) {
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Activate your account",
			text: `Use this code to verify your account: ${otp}`
		});
	}

	async sendStudentVerificationCode(email: string, code: string) {
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Your Seek student verification code",
			text: `Your Seek student verification code is ${code}. It expires in 15 minutes. If you didn't ask for it, ignore this email.`,
			html: `<p>Your Seek student verification code is <b>${escapeHtml(code)}</b>.</p><p>It expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`
		});
	}

	/**
	 * Asks a guarantor or referee to reply with the document. Replies go to the
	 * student, and a connected inbox files a reply whose subject says "reference"
	 * into their Seek Passport.
	 */
	async sendReferenceRequest(to: { name: string; email: string }, student: { name: string; email: string }, subject: string, ask: string) {
		const intro = `Hi ${to.name}, ${student.name} is renting a student home through Seek and asked us to contact you.`;
		const outro = `Just reply to this email: your reply goes straight to ${student.name} (${student.email}).`;
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			"h:Reply-To": student.email,
			to: [to.email],
			subject,
			text: `${intro}\n\n${ask}\n\n${outro}`,
			html: `<p>${escapeHtml(intro)}</p><p>${escapeHtml(ask)}</p><p>${escapeHtml(outro)}</p>`
		});
	}

	async sendNewListingEmail(user: User) {
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: ["admin@seekapp.uk"],
			subject: "New Listing Request",
			text: `${user.name} wants to upload a new listing.`,
			html: `<p>${escapeHtml(user.name)} wants to upload a new listing.</p>`
		});
	}

	async sendResetPasswordEmail(email: string, link: string) {
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Password reset",
			text: `Click this link to reset your password: ${link}`,
			html: `<p>Click <a href="${escapeHtml(link)}">here</a> to reset your password.</p>`
		});
	}

	/** Sent to the requested new address — proves the requester controls it. */
	async sendEmailChangeConfirmation(
		newEmail: string,
		token: string,
		userId: string
	) {
		const baseUrl = this.configService.get<string>(
			"FRONTEND_EMAIL_CHANGE_URL"
		) ?? `${this.configService.getOrThrow("FRONTEND_URL")}/confirmEmailChange`;
		const separator = baseUrl.includes("?") ? "&" : "?";
		const link =
			`${baseUrl}${separator}token=${encodeURIComponent(token)}` +
			`&userId=${encodeURIComponent(userId)}`;

		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [newEmail],
			subject: "Confirm your new email address",
			text: `Click this link to confirm your new email address: ${link}`,
			html: `<p>Click <a href="${escapeHtml(link)}">here</a> to confirm your new email address.</p>`
		});
	}

	/**
	 * Sent to the address currently on the account, so the real owner is told
	 * about a pending change even if somebody else is driving the session.
	 */
	async sendEmailChangeNotice(currentEmail: string, newEmail: string) {
		const body =
			`A request was made to change the email address on your Seek account to ${newEmail}. ` +
			`If this wasn't you, sign in and change your password immediately.`;

		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [currentEmail],
			subject: "Email change requested on your account",
			text: body,
			html: `<p>${escapeHtml(body)}</p>`
		});
	}

	/** A landlord sent a tenancy agreement through Seek: the tenant reads and signs it in the app. */
	async sendContractSentEmail(email: string, name: string, contractTitle: string, path: string) {
		const link = `${this.configService.getOrThrow<string>("FRONTEND_URL").split(",")[0].trim().replace(/\/$/, "")}${path}`;
		const intro = `Hi ${name}, your landlord sent you "${contractTitle}" to sign on Seek.`;
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Your tenancy agreement is ready to sign",
			text: `${intro} Read and sign it here: ${link}`,
			html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(link)}">Read and sign it on Seek</a></p>`
		});
	}

	/** A rent reminder (automatic or sent by the landlord) also reaches the tenant's inbox. */
	async sendRentReminderEmail(email: string, name: string, title: string, body: string, path: string) {
		const link = `${this.configService.getOrThrow<string>("FRONTEND_URL").split(",")[0].trim().replace(/\/$/, "")}${path}`;
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: title,
			text: `Hi ${name}, ${body} Pay here: ${link}`,
			html: `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(title)}. ${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">Pay on Seek</a></p>`
		});
	}

	async sendContactEmail(name: string, email: string, message: string) {
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			// Lets staff reply to the sender without the sender controlling
			// who the message appears to come from.
			"h:Reply-To": email,
			to: ["admin@seekapp.uk"],
			subject: "Message from Seek user",
			text: `Message from ${name} | ${email}: ${message}`,
			html: `<p>Message from ${escapeHtml(name)} | ${escapeHtml(email)}: ${escapeHtml(message)}</p>`
		});
	}

	async sendReportEmail(
		reporterName: string,
		reporterEmail: string,
		message: string,
		reportedAccount?: string
	) {
		const reported = reportedAccount?.trim();
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			"h:Reply-To": reporterEmail,
			to: ["admin@seekapp.uk"],
			subject: "User report",
			text:
				`Report from ${reporterName} | ${reporterEmail}` +
				`${reported ? ` | Reported account: ${reported}` : ""}\n\n${message}`,
			html:
				`<p><b>Report from</b> ${escapeHtml(reporterName)} | ${escapeHtml(reporterEmail)}` +
				`${reported ? ` | <b>Reported account:</b> ${escapeHtml(reported)}` : ""}</p>` +
				`<p>${escapeHtml(message)}</p>`
		});
	}

	async sendFlagCreatedEmail(
		createdByEmail: string,
		reportedUserEmail: string,
		message: { category: FlagCategory; text: string }
	) {
		await this.send({
			from: `Seek <noreply@${this.domain}>`,
			to: ["admin@seekapp.uk"],
			subject: "New flag created",
			text: `New flag created | Reported user: ${reportedUserEmail} | Reported by: ${createdByEmail} | for ${message.category}, ${message.text}`,
			html: `<p>New flag created | Reported user: ${escapeHtml(reportedUserEmail)} | Reported by: ${escapeHtml(createdByEmail)} | for ${escapeHtml(message.category)}, ${escapeHtml(message.text)}</p>`
		});
	}
}
