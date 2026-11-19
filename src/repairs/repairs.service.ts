import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Repair, RepairStatus } from "./repair.schema";
import { CreateRepairDto, MAX_REPAIR_PHOTOS, UpdateRepairDto } from "./dto/repair.dto";
import { isTenancyMember, TenanciesService } from "../tenancies/tenancies.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { UploadService } from "../upload/upload.service";
import { isKeyOwnedBy } from "../upload/object-key";

type Viewer = Pick<User, "_id" | "role">;

const STATUS_COPY: Record<RepairStatus, string> = {
	[RepairStatus.OPEN]: "is open again",
	[RepairStatus.SCHEDULED]: "has been booked in",
	[RepairStatus.FIXED]: "has been fixed"
};

@Injectable()
export class RepairsService {
	constructor(
		@InjectModel(Repair.name) private readonly repairModel: Model<Repair>,
		private readonly tenancies: TenanciesService,
		private readonly notifications: NotificationsService,
		private readonly uploads: UploadService
	) {}

	/** Signing is the access check: callers pass sign=false for non-members (e.g. Seek staff), who get no private photo links. */
	private async withPhotoUrls<T extends { photoKeys?: string[] }>(repairs: T[], sign = true) {
		return Promise.all(
			repairs.map(async repair => ({
				...repair,
				photoUrls: await Promise.all(
					(sign ? repair.photoKeys ?? [] : []).map(key => this.uploads.getPresignedDownloadUrl(key, "private", 3600))
				)
			}))
		);
	}

	async listForTenancy(tenancyId: string, viewer: Viewer) {
		const tenancy = await this.tenancies.findForMember(tenancyId, viewer);
		return this.withPhotoUrls(
			await this.repairModel
				.find({ tenancy: new Types.ObjectId(tenancyId) })
				.populate({ path: "reportedBy", select: "name profilePicUrl" })
				.sort({ createdAt: -1 })
				.lean()
				.exec(),
			isTenancyMember(tenancy, viewer._id.toString())
		);
	}

	async listForLandlord(landlordId: string) {
		return this.withPhotoUrls(
			await this.repairModel
			.find({ landlord: new Types.ObjectId(landlordId) })
			.populate({ path: "reportedBy", select: "name profilePicUrl" })
			.populate({
				path: "tenancy",
				select: "listing",
				populate: { path: "listing", select: "propertyTitle streetAddress cityTown" }
			})
			.sort({ createdAt: -1 })
			.lean()
			.exec()
		);
	}

	/** A tenant reports to the landlord; a landlord logs one on their own tenancy and tells the tenants. */
	async create(dto: CreateRepairDto, reporter: Viewer) {
		const byLandlord = reporter.role === Role.LANDLORD_AGENCY;
		const tenancy = byLandlord
			? await this.tenancies.findForLandlord(dto.tenancy, reporter)
			: await this.tenancies.findForTenant(dto.tenancy, reporter);
		const photoKeys = dto.photoKeys ?? [];
		if (photoKeys.length > MAX_REPAIR_PHOTOS) {
			throw new BadRequestException(`Attach at most ${MAX_REPAIR_PHOTOS} photos.`);
		}
		if (!photoKeys.every(key => key.startsWith("private/") && /\.(jpe?g|png|webp)$/i.test(key) && isKeyOwnedBy(key, reporter._id.toString()))) {
			throw new BadRequestException("Photo key was not issued to this account.");
		}
		const repair = await this.repairModel.create({
			tenancy: tenancy._id,
			landlord: tenancy.landlord,
			reportedBy: reporter._id,
			title: dto.title.trim(),
			description: dto.description?.trim(),
			photoKeys
		});
		if (byLandlord) {
			await this.notifications.notifyMany(
				tenancy.tenants.map(tenant => ({
					user: tenant,
					kind: NotificationKind.REPAIR_UPDATED,
					title: `Repair logged by your landlord: ${repair.title}`,
					body: repair.description,
					...notificationTarget("student", NotificationTargetKind.REPAIRS, tenancy._id)
				}))
			);
			return repair.toObject();
		}
		await this.notifications.notify({
			user: tenancy.landlord,
			kind: NotificationKind.REPAIR_REPORTED,
			title: `Repair reported: ${repair.title}`,
			body: repair.description,
			...notificationTarget("landlord", NotificationTargetKind.REPAIRS)
		});
		return repair.toObject();
	}

	async update(repairId: string, dto: UpdateRepairDto, landlord: Viewer) {
		if (!Types.ObjectId.isValid(repairId)) throw new BadRequestException("Invalid repair id.");
		const repair = await this.repairModel.findById(repairId).lean().exec();
		if (!repair) throw new NotFoundException("Repair not found.");
		if (repair.landlord.toString() !== landlord._id.toString()) {
			throw new ForbiddenException("Only the landlord can update this repair.");
		}
		if (dto.status === RepairStatus.SCHEDULED && !dto.scheduledFor && !repair.scheduledFor) {
			throw new BadRequestException("Choose when the repair is booked for.");
		}

		const set: Record<string, unknown> = { status: dto.status };
		if (dto.scheduledFor !== undefined) {
			set.scheduledFor = dto.scheduledFor ? new Date(dto.scheduledFor) : null;
		}
		set.fixedAt = dto.status === RepairStatus.FIXED ? repair.fixedAt ?? new Date() : null;

		const updated = await this.repairModel
			.findByIdAndUpdate(repair._id, { $set: set }, { new: true })
			.lean()
			.exec();

		const tenancy = await this.tenancies.findForLandlord(repair.tenancy.toString(), landlord);
		await this.notifications.notifyMany(
			tenancy.tenants.map(tenant => ({
				user: tenant,
				kind: NotificationKind.REPAIR_UPDATED,
				title: `"${repair.title}" ${STATUS_COPY[dto.status]}`,
				body: updated?.scheduledFor && dto.status === RepairStatus.SCHEDULED
					? `Booked for ${updated.scheduledFor.toUTCString()}`
					: undefined,
				...notificationTarget("student", NotificationTargetKind.REPAIRS, tenancy._id)
			}))
		);
		return updated;
	}
}
