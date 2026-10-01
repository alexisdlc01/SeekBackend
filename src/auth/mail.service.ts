import { Injectable } from "@nestjs/common";
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
	private mail: any;
	private readonly domain: string;

	constructor(private readonly configService: ConfigService) {
		const mailgun = new Mailgun(formData);
		this.mail = mailgun.client({
			username: "api",
			key: this.configService.getOrThrow("MAILGUN_API_KEY"),
			url: "https://api.eu.mailgun.net"
		});
		this.domain = this.configService.getOrThrow("MAILGUN_DOMAIN");
	}

	async sendVerificationEmail(email: string, token: string, userId: string) {
		const link: string = `${this.configService.getOrThrow("FRONTEND_URL")}/verify-email?token=${token}&userId=${userId}`;

		await this.mail.messages.create(this.domain, {
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Verify your email",
			text: `Click this link to verify your email: ${link}`,
			html: `<p>Click <a href="${escapeHtml(link)}">here</a> to verify your email address.</p>`
		});
	}

	async sendOtpEmail(email: string, otp: string) {
		await this.mail.messages.create(this.domain, {
			from: `Seek <noreply@${this.domain}>`,
			to: [email],
			subject: "Activate your account",
			text: `Use this code to verify your account: ${otp}`
		});
	}

	async sendNewListingEmail(user: User) {
		await this.mail.messages.create(this.domain, {
			from: `Seek <noreply@${this.domain}>`,
			to: ["admin@seekapp.uk"],
			subject: "New Listing Request",
			text: `${user.name} wants to upload a new listing.`,
			html: `<p>${escapeHtml(user.name)} wants to upload a new listing.</p>`
		});
	}

	async sendResetPasswordEmail(email: string, link: string) {
		await this.mail.messages.create(this.domain, {
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

		await this.mail.messages.create(this.domain, {
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

		await this.mail.messages.create(this.domain, {
			from: `Seek <noreply@${this.domain}>`,
			to: [currentEmail],
			subject: "Email change requested on your account",
			text: body,
			html: `<p>${escapeHtml(body)}</p>`
		});
	}

	async sendContactEmail(name: string, email: string, message: string) {
		await this.mail.messages.create(this.domain, {
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
		await this.mail.messages.create(this.domain, {
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
		await this.mail.messages.create(this.domain, {
			from: `Seek <noreply@${this.domain}>`,
			to: ["admin@seekapp.uk"],
			subject: "New flag created",
			text: `New flag created | Reported user: ${reportedUserEmail} | Reported by: ${createdByEmail} | for ${message.category}, ${message.text}`,
			html: `<p>New flag created | Reported user: ${escapeHtml(reportedUserEmail)} | Reported by: ${escapeHtml(createdByEmail)} | for ${escapeHtml(message.category)}, ${escapeHtml(message.text)}</p>`
		});
	}
}
