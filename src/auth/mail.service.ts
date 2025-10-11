import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Mailgun from "mailgun.js";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
const formData = require("form-data");

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
			from: "Seek <noreply@mail.seekapp.uk>",
			to: [email],
			subject: "Verify your email",
			text: `Click this link to verify your email: ${link}`,
			html: `<p>Click <a href="${link}">here</a> to verify your email address.</p>`
		});
	}

	async sendNewListingEmail(user: User) {
		await this.mail.messages.create(this.domain, {
			from: "Seek <noreply@mail.seekapp.uk>",
			to: ["admin@seekapp.uk"],
			subject: "New Listing Request",
			text: `${user.name} wants to upload a new listing.`,
			html: `<p>${user.name} wants to upload a new listing.</p>`
		});
	}

	async sendResetPasswordEmail(email: string, link: string) {
		await this.mail.messages.create(this.domain, {
			from: "Seek <noreply@mail.seekapp.uk>",
			to: [email],
			subject: "Password reset",
			text: `Click this link to reset your password: ${link}`,
			html: `<p>Click <a href="${link}">here</a> to verify your email address.</p>`
		});
	}

	async sendContactEmail(name: string, email: string, message: string) {
		await this.mail.messages.create(this.domain, {
			from: "Seek <noreply@mail.seekapp.uk>",
			to: ["admin@seekapp.uk"],
			subject: "Message from Seek user",
			text: `Message from ${name} | ${email}: ${message}`,
			html: `<p>Message from ${name} | ${email}: ${message}</p>`
		});
	}
}
