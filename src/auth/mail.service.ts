import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Mailgun from "mailgun.js";
const formData = require("form-data");

@Injectable()
export class MailService {
	private mail;

	constructor(private readonly configService: ConfigService) {
		const mailgun = new Mailgun(formData);
		this.mail = mailgun.client({
			username: "api",
			key: this.configService.getOrThrow("MAILGUN_API_KEY"),
			url: "https://api.eu.mailgun.net"
		});
	}

	async sendVerificationEmail(email: string, token: string) {
		const domain = this.configService.getOrThrow("MAILGUN_DOMAIN");
		const link: string = `${this.configService.getOrThrow("FRONTEND_URL")}/verify-email?token=${token}`;

		await this.mail.messages.create(domain, {
			from: "Seek <noreply@mail.seekapp.uk>",
			to: [email],
			subject: "Verify your email",
			text: `Click this link to verify your email: ${link}`,
			html: `<p>Click <a href="${link}">here</a> to verify your email address.</p>`
		});
	}
}
