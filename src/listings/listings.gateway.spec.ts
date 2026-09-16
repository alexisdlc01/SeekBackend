import { sign } from "jsonwebtoken";
import { Types } from "mongoose";
import { Socket } from "socket.io";
import { Role } from "../auth/role.enum";
import UsersService from "../users/users.service";
import { User } from "../users/users.schema";
import { landlordListingsRoom, ListingsGateway } from "./listings.gateway";
import { Listing } from "./listings.schema";

describe("ListingsGateway", () => {
	const secret = "listings-gateway-test-secret";
	const landlordId = new Types.ObjectId();
	let gateway: ListingsGateway;
	let usersService: { getUserForSession: jest.Mock };
	let previousSecret: string | undefined;
	let previousVerificationFlag: string | undefined;

	beforeEach(() => {
		previousSecret = process.env.JWT_ACCESS_TOKEN_SECRET;
		previousVerificationFlag = process.env.AUTH_EMAIL_VERIFICATION_ENABLED;
		process.env.JWT_ACCESS_TOKEN_SECRET = secret;
		process.env.AUTH_EMAIL_VERIFICATION_ENABLED = "false";
		usersService = { getUserForSession: jest.fn() };
		gateway = new ListingsGateway(usersService as unknown as UsersService);
	});

	afterEach(() => {
		jest.useRealTimers();
		if (previousSecret === undefined) {
			delete process.env.JWT_ACCESS_TOKEN_SECRET;
		} else {
			process.env.JWT_ACCESS_TOKEN_SECRET = previousSecret;
		}
		if (previousVerificationFlag === undefined) {
			delete process.env.AUTH_EMAIL_VERIFICATION_ENABLED;
		} else {
			process.env.AUTH_EMAIL_VERIFICATION_ENABLED =
				previousVerificationFlag;
		}
		jest.restoreAllMocks();
	});

	it("accepts landlords and derives their room from the authenticated user", async () => {
		const user = makeUser(Role.LANDLORD_AGENCY);
		usersService.getUserForSession.mockResolvedValue(user);
		const client = makeAuthenticatedSocket();
		const middleware = captureMiddleware(gateway);

		await runMiddleware(middleware, client);
		await gateway.handleConnection(client);

		expect(client.join).toHaveBeenCalledWith(
			landlordListingsRoom(landlordId.toString())
		);
		expect(client.data.user).toBe(user);
		expect(client.data.listingsSession).toEqual(
			expect.objectContaining({
				userId: landlordId.toString(),
				sessionId: "session-1",
				role: Role.LANDLORD_AGENCY
			})
		);
		gateway.handleDisconnect(client);
	});

	it("rejects students before they can subscribe", async () => {
		usersService.getUserForSession.mockResolvedValue(
			makeUser(Role.STUDENT)
		);
		const client = makeAuthenticatedSocket();
		const middleware = captureMiddleware(gateway);

		await expect(runMiddleware(middleware, client)).rejects.toThrow(
			"Listings socket authentication failed."
		);
		expect(client.join).not.toHaveBeenCalled();
	});

	it("emits draft payloads only to the owner room and redacts sensitive fields", () => {
		const emit = jest.fn();
		const to = jest.fn().mockReturnValue({ emit });
		gateway.server = { to } as any;
		const listing = makeListing(true);

		gateway.emitListingUpdated(listing);

		expect(to).toHaveBeenCalledWith([
			landlordListingsRoom(landlordId.toString())
		]);
		expect(emit).toHaveBeenCalledWith(
			"listingUpdated",
			expect.objectContaining({
				_id: listing._id.toString(),
				landlord: landlordId.toString(),
				propertyTitle: "Private draft"
			})
		);
		const payload = emit.mock.calls[0][1];
		expect(payload).not.toHaveProperty("registerOfTitleKey");
		expect(payload).not.toHaveProperty("registrationNumber");
		expect(payload).not.toHaveProperty("likedBy");
		expect(payload).not.toHaveProperty("__v");
	});

	it("also notifies the superuser room after a listing is published", () => {
		const emit = jest.fn();
		const to = jest.fn().mockReturnValue({ emit });
		gateway.server = { to } as any;

		gateway.emitListingCreated(makeListing(false));

		expect(to).toHaveBeenCalledWith([
			landlordListingsRoom(landlordId.toString()),
			"listings:superusers"
		]);
		expect(emit).toHaveBeenCalledWith("listingCreated", expect.any(Object));
	});

	it("routes deletion by the deleted listing owner without exposing the listing", () => {
		const emit = jest.fn();
		const to = jest.fn().mockReturnValue({ emit });
		gateway.server = { to } as any;
		const listing = makeListing(true);

		gateway.emitListingDeleted(listing);

		expect(to).toHaveBeenCalledWith([
			landlordListingsRoom(landlordId.toString())
		]);
		expect(emit).toHaveBeenCalledWith(
			"listingDeleted",
			listing._id.toString()
		);
	});

	it("disconnects an existing socket when its session is revoked", async () => {
		const client = makeConnectedSocket();
		usersService.getUserForSession.mockRejectedValue(new Error("revoked"));

		await (gateway as any).revalidateClient(client);

		expect(client.disconnect).toHaveBeenCalled();
	});

	it("disconnects the listings namespace when the access token expires", async () => {
		jest.useFakeTimers().setSystemTime(new Date("2026-08-08T12:00:00Z"));
		const client = makeConnectedSocket();
		client.join = jest.fn().mockResolvedValue(undefined);
		client.data.listingsSession.exp = Math.floor(Date.now() / 1000) + 1;

		await gateway.handleConnection(client);
		jest.advanceTimersByTime(1_000);

		expect(client.disconnect).toHaveBeenCalledWith();
		gateway.handleDisconnect(client);
	});

	function makeUser(role: Role): User {
		return {
			_id: landlordId,
			role,
			isVerified: true
		} as User;
	}

	function makeAuthenticatedSocket(): Socket {
		const token = sign(
			{ userId: landlordId.toString(), sessionId: "session-1" },
			secret,
			{ expiresIn: "15m" }
		);
		return {
			id: "socket-1",
			data: {},
			connected: true,
			handshake: {
				headers: {
					platform: "mobile",
					authorization: `Bearer ${token}`
				},
				query: {}
			},
			join: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn()
		} as unknown as Socket;
	}

	function makeConnectedSocket(): Socket {
		return {
			id: "socket-2",
			data: {
				user: makeUser(Role.LANDLORD_AGENCY),
				listingsSession: {
					userId: landlordId.toString(),
					sessionId: "session-1",
					exp: Math.floor(Date.now() / 1000) + 900,
					role: Role.LANDLORD_AGENCY
				}
			},
			connected: true,
			disconnect: jest.fn()
		} as unknown as Socket;
	}

	function makeListing(isDraft: boolean): Listing {
		const id = new Types.ObjectId();
		const raw = {
			_id: id,
			landlord: landlordId,
			propertyTitle: "Private draft",
			isDraft,
			isVerified: false,
			registerOfTitleKey: "private/storage-key.pdf",
			registrationNumber: "secret-registration",
			likedBy: [new Types.ObjectId()],
			__v: 4
		};
		return {
			...raw,
			toObject: () => ({ ...raw })
		} as unknown as Listing;
	}

	function captureMiddleware(subject: ListingsGateway) {
		let middleware:
			| ((client: Socket, next: (error?: Error) => void) => void)
			| undefined;
		const server = {
			use: jest.fn(handler => {
				middleware = handler;
			})
		};
		subject.afterInit(server as any);
		return middleware!;
	}

	function runMiddleware(
		middleware: (client: Socket, next: (error?: Error) => void) => void,
		client: Socket
	): Promise<void> {
		return new Promise((resolve, reject) => {
			middleware(client, error => (error ? reject(error) : resolve()));
		});
	}
});
