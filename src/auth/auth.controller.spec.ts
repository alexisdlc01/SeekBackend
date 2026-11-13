import { firstValueFrom, of } from "rxjs";
import { AuthController } from "./auth.controller";
import { SerializeInterceptor } from "../interceptors/serialize.interceptor";
import { UserDto } from "../users/dto/user.dto";

describe("AuthController", () => {
	let controller: AuthController;
	let authService: Record<string, jest.Mock>;
	let response: { cookie: jest.Mock; clearCookie: jest.Mock };

	beforeEach(() => {
		authService = {
			signup: jest.fn(),
			login: jest.fn(),
			verifyEmail: jest.fn(),
			resendOtp: jest.fn(),
			resetPassword: jest.fn(),
			confirmResetPassword: jest.fn(),
			changePassword: jest.fn(),
			clearAuthCookies: jest.fn(),
			logout: jest.fn()
		};
		response = { cookie: jest.fn(), clearCookie: jest.fn() };
		controller = new AuthController(authService as never, {} as never);
	});

	it("currentUser keeps payoutsConnected true after serialization", async () => {
		const user = { _id: "u1", name: "Ada", stripeAccountId: "acct_123" };
		const handled = await controller.currentUser(user as never);
		const out: any = await firstValueFrom(
			new SerializeInterceptor(UserDto).intercept({} as never, { handle: () => of(handled) })
		);
		expect(out.payoutsConnected).toBe(true);
	});

	it("returns tokens immediately for mobile signup when verification is disabled", async () => {
		const user = { _id: "user-1" };
		authService.signup.mockResolvedValue({
			verificationRequired: false,
			user
		});
		authService.login.mockResolvedValue({
			access_token: "access",
			refresh_token: "refresh"
		});

		await expect(controller.signup(
			{ name: "Ada", email: "ada@example.com", password: "Password!1" },
			{ headers: { platform: "mobile" } } as never,
			response as never
		)).resolves.toEqual({
			verificationRequired: false,
			access_token: "access",
			refresh_token: "refresh"
		});
		expect(authService.login).toHaveBeenCalledWith(user, response, true);
	});

	it("does not create a session while verification is pending", async () => {
		authService.signup.mockResolvedValue({
			verificationRequired: true,
			userId: "user-1"
		});

		await expect(controller.signup(
			{ name: "Ada", email: "ada@example.com", password: "Password!1" },
			{ headers: {} } as never,
			response as never
		)).resolves.toEqual({
			verificationRequired: true,
			userId: "user-1"
		});
		expect(authService.login).not.toHaveBeenCalled();
	});

	it("refuses a landlord signing in from the mobile app, but not from the web", async () => {
		const landlord = { _id: "l1", role: "LANDLORD_AGENCY" };
		await expect(controller.login(landlord as never, { headers: { platform: "mobile" } } as never, response as never))
			.rejects.toThrow("Landlords use Seek on the web");
		expect(authService.login).not.toHaveBeenCalled();

		await controller.login(landlord as never, { headers: {} } as never, response as never);
		await controller.login({ _id: "s1", role: "STUDENT" } as never, { headers: { platform: "mobile" } } as never, response as never);
		expect(authService.login).toHaveBeenCalledTimes(2);
	});

	it("selects the mobile reset-link flow from the platform header", async () => {
		authService.resetPassword.mockResolvedValue({ message: "generic" });

		await controller.forgotPassword(
			{ email: "ada@example.com" },
			{ headers: { platform: "mobile" } } as never
		);

		expect(authService.resetPassword).toHaveBeenCalledWith(
			"ada@example.com",
			true
		);
	});

	it("clears browser cookies after a successful password reset", async () => {
		authService.confirmResetPassword.mockResolvedValue({ message: "reset" });

		await controller.confirmPasswordReset(
			{ userId: "507f1f77bcf86cd799439011", token: "token", newPassword: "Password!1" },
			{ headers: {} } as never,
			response as never
		);

		expect(authService.clearAuthCookies).toHaveBeenCalledWith(response);
	});

	it("logout still authenticates from the Refresh cookie once the access token lapsed", async () => {
		const passport = require("passport");
		passport.use("jwt", { authenticate() { (this as any).fail(401); } });
		passport.use("jwt-refresh", { authenticate(req: any) {
			return req.cookies?.Refresh ? (this as any).success({ _id: "u1", authSessionId: "s1" }) : (this as any).fail(401);
		} });
		const [Guard] = Reflect.getMetadata("__guards__", AuthController.prototype.logout);
		const req: any = { headers: {}, cookies: { Refresh: "refresh-token" } };
		const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }) };

		await expect(new Guard().canActivate(ctx)).resolves.toBe(true);
		expect(req.user).toEqual({ _id: "u1", authSessionId: "s1" });
	});
});
