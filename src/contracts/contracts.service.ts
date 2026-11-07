import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Contract, ContractStatus, ContractTemplateKind, DeductionStatus } from "./contract.schema";
import { CreateContractDto } from "./dto/create-contract.dto";
import { TenanciesService, isTenant } from "../tenancies/tenancies.service";
import { DocumentSource, TenancyDocumentType } from "../tenancies/tenancy.enums";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";
import { User } from "../users/users.schema";
import { MailService } from "../auth/mail.service";
import { isKeyOwnedBy } from "../upload/object-key";
import { allTenantsSigned } from "./signing";
import { ContractTemplate } from "./contract-template.schema";
import { CreateContractTemplateDto } from "./dto/create-contract-template.dto";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Tenancy } from "../tenancies/tenancy.schema";
import { Nation } from "../listings/enums/nation.enum";
import { Listing } from "../listings/listings.schema";
import {
	ContractDocument,
	ContractDocumentData,
	documentSignature,
	isValidSignature,
	renderAgreement,
	renderPrescribedInformation
} from "./contract-documents";
import { DeductionsDto, InventoryDto, RespondDeductionsDto } from "./dto/contract-extras.dto";

type Viewer = Pick<User, "_id" | "role">;

@Injectable()
export class ContractsService {
	private readonly logger = new Logger(ContractsService.name);
	constructor(
		@InjectModel(Contract.name) private readonly contractModel: Model<Contract>,
		@InjectModel(ContractTemplate.name) private readonly templateModel: Model<ContractTemplate>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		private readonly tenancies: TenanciesService,
		private readonly notifications: NotificationsService,
		private readonly config: ConfigService,
		@InjectModel(User.name) private readonly userModel?: Model<User>,
		private readonly mail?: MailService
	) {}

	/** Drafts Seek's own agreement for the tenancy, following the law of the nation the home is in. */
	async createDefault(tenancyId: string, landlord: Viewer) {
		const tenancy = await this.tenancies.findForLandlord(tenancyId, landlord);
		const listing = await this.listingModel.findById(tenancy.listing, { nation: 1 }).lean().exec();
		const nation = listing?.nation ?? Nation.ENGLAND;
		if (nation !== Nation.ENGLAND && nation !== Nation.WALES) {
			throw new BadRequestException(
				"Seek's agreement covers homes in England and Wales. Upload your own agreement for this property."
			);
		}
		const wales = nation === Nation.WALES;
		const _id = new Types.ObjectId();
		const contract = await this.contractModel.create({
			_id,
			tenancy: tenancy._id,
			landlord: tenancy.landlord,
			title: wales ? "Standard occupation contract (Wales)" : "Assured periodic tenancy agreement",
			url: this.documentUrl(_id.toString(), "agreement"),
			prescribedInformationUrl: this.documentUrl(_id.toString(), "prescribed-information"),
			templateKind: wales ? ContractTemplateKind.WALES_STANDARD_OCCUPATION : ContractTemplateKind.ENGLAND_ASSURED_PERIODIC,
			source: DocumentSource.SEEK,
			status: ContractStatus.DRAFT
		});
		return contract.toObject();
	}

	/** HTML of a Seek agreement or its prescribed information, for whoever holds the signed link. */
	async renderDocument(contractId: string, doc: ContractDocument, signature: string) {
		if (!isValidSignature(this.secret(), contractId, doc, signature)) {
			throw new ForbiddenException("This document link is not valid.");
		}
		const contract = await this.find(contractId);
		if (!contract.templateKind) throw new NotFoundException("This contract was uploaded, so Seek has no copy to show.");
		const tenancy = await this.tenancyModel
			.findById(contract.tenancy)
			.populate({ path: "listing", select: "streetAddress cityTown postcodeZIP billsIncluded licenceNumber" })
			.populate({ path: "landlord", select: "name email companyName" })
			.populate({ path: "tenants", select: "name email" })
			.lean()
			.exec();
		if (!tenancy) throw new NotFoundException("Tenancy not found.");
		const listing = tenancy.listing as unknown as {
			streetAddress?: string;
			cityTown?: string;
			postcodeZIP?: string;
			billsIncluded?: boolean;
			licenceNumber?: string;
		} | null;
		const data: ContractDocumentData = {
			kind: contract.templateKind,
			title: contract.title,
			landlord: (tenancy.landlord as unknown as ContractDocumentData["landlord"]) ?? {},
			tenants: (tenancy.tenants as unknown as ContractDocumentData["tenants"]) ?? [],
			address: [listing?.streetAddress, listing?.cityTown, listing?.postcodeZIP].filter(Boolean).join(", "),
			startDate: tenancy.startDate,
			monthlyRent: tenancy.monthlyRent,
			depositAmount: tenancy.depositAmount,
			depositScheme: tenancy.depositScheme,
			depositReference: tenancy.depositReference,
			depositReceivedAt: tenancy.depositReceivedAt,
			depositProtectedAt: tenancy.depositProtectedAt,
			billsIncluded: listing?.billsIncluded,
			licenceNumber: listing?.licenceNumber
		};
		return doc === "agreement" ? renderAgreement(data) : renderPrescribedInformation(data);
	}

	/** Records the check-in inventory and tells the tenants it is ready to check. */
	async setInventory(contractId: string, dto: InventoryDto, landlord: Viewer) {
		const contract = await this.find(contractId);
		const tenancy = await this.tenancies.findForLandlord(contract.tenancy.toString(), landlord);
		const updated = await this.contractModel
			.findByIdAndUpdate(
				contract._id,
				{
					$set: {
						inventory: {
							items: dto.items.map(item => ({ ...item, photoUrls: item.photoUrls ?? [] })),
							recordedAt: new Date()
						}
					}
				},
				{ new: true }
			)
			.lean()
			.exec();
		await this.notifications.notifyMany(
			tenancy.tenants.map(tenant => ({
				user: tenant,
				kind: NotificationKind.INVENTORY_RECORDED,
				title: "Your check-in inventory is ready",
				body: `${dto.items.length} items recorded. Tell your landlord now if anything is missing or wrong.`,
				...notificationTarget("student", NotificationTargetKind.CONTRACTS, tenancy._id),
				dedupeKey: `inventory:${contract._id.toString()}:${updated!.inventory!.recordedAt.getTime()}`
			}))
		);
		return updated;
	}

	/**
	 * Proposes end-of-tenancy deductions from the joint deposit. They can never
	 * exceed the deposit, and every earlier answer is cleared.
	 */
	async proposeDeductions(contractId: string, dto: DeductionsDto, landlord: Viewer) {
		const contract = await this.find(contractId);
		const tenancy = await this.tenancies.findForLandlord(contract.tenancy.toString(), landlord);
		if (contract.status !== ContractStatus.SIGNED) {
			throw new BadRequestException("Deductions can only be proposed on a signed agreement.");
		}
		const total = dto.items.reduce((sum, item) => sum + item.amount, 0);
		const deposit = tenancy.depositAmount * tenancy.tenants.length;
		if (total > deposit) {
			throw new BadRequestException(
				`Deductions total £${(total / 100).toFixed(2)}, more than the £${(deposit / 100).toFixed(2)} deposit.`
			);
		}
		const proposedAt = new Date();
		const updated = await this.contractModel
			.findByIdAndUpdate(
				contract._id,
				{ $set: { deductions: { items: dto.items, total, status: DeductionStatus.PROPOSED, responses: [], proposedAt } } },
				{ new: true }
			)
			.lean()
			.exec();
		await this.notifications.notifyMany(
			tenancy.tenants.map(tenant => ({
				user: tenant,
				kind: NotificationKind.DEPOSIT_DEDUCTIONS,
				title: total ? "Your landlord proposed deposit deductions" : "Your landlord will return the whole deposit",
				body: total
					? `£${(total / 100).toFixed(2)} from the £${(deposit / 100).toFixed(2)} deposit. Accept or dispute them in Seek.`
					: "Confirm in Seek so the scheme can release it.",
				...notificationTarget("student", NotificationTargetKind.COMPLIANCE, tenancy._id),
				dedupeKey: `deductions:${contract._id.toString()}:${proposedAt.getTime()}`
			}))
		);
		return updated;
	}

	/** A tenant accepts or disputes the deductions: one dispute settles it as DISPUTED, everyone's yes as ACCEPTED. */
	async respondToDeductions(contractId: string, dto: RespondDeductionsDto, tenant: Viewer) {
		const contract = await this.find(contractId);
		const tenancy = await this.tenancies.findForTenant(contract.tenancy.toString(), tenant);
		if (!contract.deductions) throw new BadRequestException("Your landlord has not proposed any deductions.");
		if (contract.deductions.status !== DeductionStatus.PROPOSED) {
			throw new BadRequestException(`These deductions are already ${contract.deductions.status.toLowerCase()}.`);
		}
		const responses = [
			...contract.deductions.responses.filter(response => !response.user.equals(tenant._id)),
			{ user: tenant._id, accepted: dto.accept, note: dto.note?.trim() || undefined, at: new Date() }
		];
		const agreed = new Set(responses.filter(response => response.accepted).map(response => response.user.toString()));
		const status = responses.some(response => !response.accepted)
			? DeductionStatus.DISPUTED
			: tenancy.tenants.every(id => agreed.has(id.toString()))
				? DeductionStatus.ACCEPTED
				: DeductionStatus.PROPOSED;
		const updated = await this.contractModel
			.findOneAndUpdate(
				// Only answers to the proposal and responses this tenant saw count: a concurrent answer makes this one retry.
				{
					_id: contract._id,
					"deductions.proposedAt": contract.deductions.proposedAt,
					"deductions.status": DeductionStatus.PROPOSED,
					"deductions.responses": contract.deductions.responses
				},
				{ $set: { "deductions.responses": responses, "deductions.status": status } },
				{ new: true }
			)
			.lean()
			.exec();
		if (!updated) throw new BadRequestException("The deductions changed. Reload and check them again.");
		if (status !== DeductionStatus.PROPOSED) {
			await this.notifications.notify({
				user: tenancy.landlord,
				kind: NotificationKind.DEPOSIT_DEDUCTIONS,
				title: status === DeductionStatus.ACCEPTED ? "Tenants accepted the deductions" : "A tenant disputed the deductions",
				body:
					status === DeductionStatus.ACCEPTED
						? "Ask the deposit scheme to release the deposit."
						: "Talk it through with them, or the deposit scheme's free dispute service will decide.",
				...notificationTarget("landlord", NotificationTargetKind.CONTRACTS, tenancy._id),
				dedupeKey: `deductions-${status}:${contract._id.toString()}:${contract.deductions.proposedAt.getTime()}`
			});
		}
		return updated;
	}

	private secret() {
		const secret = this.config.get<string>("JWT_ACCESS_TOKEN_SECRET");
		if (!secret) throw new Error("JWT_ACCESS_TOKEN_SECRET is required to sign document links.");
		return secret;
	}

	private documentUrl(contractId: string, doc: ContractDocument) {
		const base = (
			this.config.get<string>("API_URL") ||
			this.config.get<string>("CONNECTORS_CALLBACK_BASE_URL") ||
			`http://localhost:${this.config.get<string>("PORT") ?? 3000}`
		).replace(/\/$/, "");
		const path = doc === "agreement" ? "document" : "prescribed-information";
		return `${base}/contracts/${contractId}/${path}?sig=${documentSignature(this.secret(), contractId, doc)}`;
	}

	async create(dto: CreateContractDto, landlord: Viewer) {
		const tenancy = await this.tenancies.findForLandlord(dto.tenancy, landlord);
		if (dto.key && !isKeyOwnedBy(dto.key, landlord._id.toString())) {
			throw new BadRequestException("Document key was not issued to this account.");
		}
		const contract = await this.contractModel.create({
			tenancy: tenancy._id,
			landlord: tenancy.landlord,
			title: dto.title.trim(),
			url: dto.url,
			key: dto.key,
			source: dto.source ?? DocumentSource.UPLOAD,
			status: ContractStatus.DRAFT
		});
		return contract.toObject();
	}

	async createTemplate(dto: CreateContractTemplateDto, landlord: Viewer) {
		if (dto.key && !isKeyOwnedBy(dto.key, landlord._id.toString())) {
			throw new BadRequestException("Document key was not issued to this account.");
		}
		const template = await this.templateModel.create({
			landlord: landlord._id,
			title: dto.title.trim(),
			url: dto.url,
			key: dto.key
		});
		return template.toObject();
	}

	async listTemplates(landlordId: string) {
		return this.templateModel
			.find({ landlord: new Types.ObjectId(landlordId) })
			.sort({ createdAt: -1 })
			.lean()
			.exec();
	}

	async deleteTemplate(id: string, landlord: Viewer): Promise<void> {
		const result = await this.templateModel
			.deleteOne({ _id: new Types.ObjectId(id), landlord: landlord._id })
			.exec();
		if (result.deletedCount === 0) throw new NotFoundException("Template not found.");
	}

	async listForTenancy(tenancyId: string, viewer: Viewer) {
		await this.tenancies.findForMember(tenancyId, viewer);
		return this.contractModel
			.find({ tenancy: new Types.ObjectId(tenancyId) })
			.populate({ path: "signatures.user", select: "name profilePicUrl" })
			.sort({ createdAt: -1 })
			.lean()
			.exec();
	}

	async listForLandlord(landlordId: string) {
		return this.contractModel
			.find({ landlord: new Types.ObjectId(landlordId) })
			.populate({
				path: "tenancy",
				select: "listing tenants startDate status",
				populate: [
					{ path: "listing", select: "propertyTitle streetAddress cityTown" },
					{ path: "tenants", select: "name profilePicUrl" }
				]
			})
			.populate({ path: "signatures.user", select: "name profilePicUrl" })
			.sort({ createdAt: -1 })
			.lean()
			.exec();
	}

	async send(contractId: string, landlord: Viewer) {
		const contract = await this.find(contractId);
		const tenancy = await this.tenancies.findForLandlord(contract.tenancy.toString(), landlord);
		if (contract.status !== ContractStatus.DRAFT) {
			throw new BadRequestException("Only a draft contract can be sent.");
		}
		const updated = await this.contractModel
			.findOneAndUpdate(
				{ _id: contract._id, status: ContractStatus.DRAFT },
				{ $set: { status: ContractStatus.SENT, sentAt: new Date() } },
				{ new: true }
			)
			.lean()
			.exec();
		if (!updated) throw new BadRequestException("Only a draft contract can be sent.");
		await this.notifications.notifyMany(
			tenancy.tenants.map(tenant => ({
				user: tenant,
				kind: NotificationKind.CONTRACT_SENT,
				title: "Your tenancy agreement is ready to sign",
				body: contract.title,
				...notificationTarget("student", NotificationTargetKind.CONTRACTS, tenancy._id),
				dedupeKey: `contract-sent:${contract._id.toString()}`
			}))
		);
		await this.emailContractSent(tenancy.tenants, contract.title);
		return updated;
	}

	/** The agreement also reaches each tenant's inbox. A mail failure never undoes the send. */
	private async emailContractSent(tenantIds: Types.ObjectId[], title: string) {
		if (!this.mail || !this.userModel) return;
		const users = await this.userModel.find({ _id: { $in: tenantIds } }, { email: 1, name: 1 }).lean().exec();
		const { link } = notificationTarget("student", NotificationTargetKind.CONTRACTS);
		await Promise.all(
			users.map(user =>
				this.mail!.sendContractSentEmail(user.email, user.name ?? "there", title, link).catch(error =>
					this.logger.warn(`Contract email to ${user._id.toString()} failed: ${(error as Error).message}`)
				)
			)
		);
	}

	async sign(contractId: string, tenant: Viewer) {
		const contract = await this.find(contractId);
		const tenancy = await this.tenancies.findForTenant(contract.tenancy.toString(), tenant);
		if (contract.status === ContractStatus.DRAFT) {
			throw new BadRequestException("The landlord has not sent this contract yet.");
		}
		if (contract.status === ContractStatus.SIGNED) {
			return contract;
		}
		if (!isTenant(tenancy, tenant._id.toString())) {
			throw new ForbiddenException("Only a tenant of this tenancy can sign.");
		}

		const now = new Date();
		const withSignature = await this.contractModel
			.findOneAndUpdate(
				{
					_id: contract._id,
					status: ContractStatus.SENT,
					"signatures.user": { $ne: tenant._id }
				},
				{ $push: { signatures: { user: tenant._id, signedAt: now } } },
				{ new: true }
			)
			.lean()
			.exec();
		const current = withSignature ?? (await this.find(contractId));

		if (current.status === ContractStatus.SENT && allTenantsSigned(tenancy.tenants, current.signatures)) {
			const signed = await this.contractModel
				.findOneAndUpdate(
					{ _id: contract._id, status: ContractStatus.SENT },
					{ $set: { status: ContractStatus.SIGNED, signedAt: now } },
					{ new: true }
				)
				.lean()
				.exec();
			// Only the request that flips the status files the agreement.
			if (signed) {
				await this.tenancies.appendDocument(tenancy._id, {
					type: TenancyDocumentType.TENANCY_AGREEMENT,
					title: contract.title,
					url: contract.url,
					key: contract.key,
					source: DocumentSource.SEEK
				});
				await this.notifications.notify({
					user: tenancy.landlord,
					kind: NotificationKind.CONTRACT_SIGNED,
					title: "Everyone has signed",
					body: contract.title,
					...notificationTarget("landlord", NotificationTargetKind.CONTRACTS, tenancy._id),
					dedupeKey: `contract-signed:${contract._id.toString()}`
				});
				// The pipeline ends here: an accepted household with a signed agreement.
				if (tenancy.application) {
					await this.applicationModel
						.updateOne(
							{ _id: tenancy.application, stage: ApplicationStage.ACCEPTED },
							{ $set: { stage: ApplicationStage.SIGNED } }
						)
						.exec();
				}
				return signed;
			}
		}
		return this.find(contractId);
	}

	private async find(contractId: string) {
		if (!Types.ObjectId.isValid(contractId)) throw new BadRequestException("Invalid contract id.");
		const contract = await this.contractModel.findById(contractId).lean().exec();
		if (!contract) throw new NotFoundException("Contract not found.");
		return contract;
	}
}
