import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiOperation, ApiParam, ApiResponse } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { ConnectorsService } from "./connectors.service";
import {
	AuthUrlDto,
	AuthUrlQueryDto,
	ConfirmConnectorDto,
	ConnectImapDto,
	EmailConnectionViewDto,
	ConnectorSettingsDto,
	ConnectorsOverviewDto,
	DisconnectResultDto,
	ImapConnectResultDto,
	UpdateConnectorSettingsDto,
	SyncResultDto,
	ConnectionMatchDto
} from "./dto/connectors.dto";

@Controller("connectors")
export class ConnectorsController {
	constructor(private readonly connectors: ConnectorsService) {}

	@Get()
	@StudentOrLandlord()
	@ApiOperation({ summary: "Your connected mailboxes and the providers this server can connect." })
	@ApiResponse({ status: 200, type: ConnectorsOverviewDto })
	async overview(@CurrentUser() user: User) {
		return this.connectors.overview(user);
	}

	@Patch("settings")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Choose what mailboxes import (housing only or all emails) and whether attachments are filed automatically." })
	@ApiResponse({ status: 200, type: ConnectorSettingsDto })
	updateSettings(@Body() dto: UpdateConnectorSettingsDto, @CurrentUser() user: User) {
		return this.connectors.updateSettings(user, dto);
	}

	@Post("imap")
	@StudentOrLandlord()
	@ApiOperation({
		summary: "Connect any mailbox over IMAP with an app password (stored encrypted), then sync it.",
		description: "Outside production, a server that cannot be signed in to falls back to the demo mailbox (mode: demo)."
	})
	@ApiResponse({ status: 201, type: ImapConnectResultDto })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Sign-in failed (production)." })
	@ApiResponse({ status: 503, type: ErrorDto })
	connectImap(@Body() dto: ConnectImapDto, @CurrentUser() user: User) {
		return this.connectors.connectImap(user, dto);
	}

	@Get(":provider/auth-url")
	@StudentOrLandlord()
	@ApiOperation({ summary: "OAuth consent URL for Gmail or Outlook (read housing emails, reply from your address)." })
	@ApiParam({ name: "provider", enum: ["gmail", "outlook"], description: "Canonical lowercase; any casing is accepted." })
	@ApiResponse({ status: 200, type: AuthUrlDto })
	@ApiResponse({ status: 503, type: ErrorDto, description: "Provider not set up on this server." })
	authUrl(@Param("provider") provider: string, @Query() query: AuthUrlQueryDto, @CurrentUser() user: User) {
		return this.connectors.authUrl(user, provider, query.client ?? "web", query.returnTo);
	}

	@Get(":provider/callback")
	@ApiExcludeEndpoint()
	async callback(
		@Param("provider") provider: string,
		@Query("code") code: string | undefined,
		@Query("state") state: string | undefined,
		@Query("error") error: string | undefined,
		@Req() req: Request,
		@Res() res: Response
	) {
		const target = await this.connectors.handleCallback(provider, { code, state, error }, req.cookies?.Authentication);
		res.redirect(302, target);
	}

	@Post(":provider/confirm")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Mobile: activate the mailbox from the OAuth redirect (status=pending&nonce=...) for the signed-in user." })
	@ApiParam({ name: "provider", enum: ["gmail", "outlook"] })
	@ApiResponse({ status: 201, type: EmailConnectionViewDto })
	@ApiResponse({ status: 400, type: ErrorDto, description: "Expired, already used, or started from another account." })
	confirm(@Param("provider") provider: string, @Body() dto: ConfirmConnectorDto, @CurrentUser() user: User) {
		return this.connectors.confirmPending(user, provider, dto.nonce);
	}

	@Post("demo")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Connect the demo mailbox (sample housing emails). Not available in production." })
	@ApiResponse({ status: 201, type: SyncResultDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async connectDemo(@CurrentUser() user: User) {
		return this.connectors.connectDemo(user);
	}

	@Post(":id/sync")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Fetch new housing emails and file their attachments." })
	@ApiResponse({ status: 201, type: SyncResultDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	@ApiResponse({ status: 502, type: ErrorDto })
	async sync(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.connectors.sync(user, id);
	}

	@Get(":id/matches")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Housing contacts matched in this mailbox (up to 50, newest first). No message content." })
	@ApiResponse({ status: 200, type: [ConnectionMatchDto] })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async matches(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.connectors.matches(user, id);
	}

	@Delete(":id")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Disconnect a mailbox and delete the emails stored from it." })
	@ApiResponse({ status: 200, type: DisconnectResultDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async disconnect(@Param("id", ParseObjectIdPipe) id: string, @CurrentUser() user: User) {
		return this.connectors.disconnect(user, id);
	}
}
