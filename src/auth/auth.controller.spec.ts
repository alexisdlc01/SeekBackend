import { AuthController } from "./auth.controller";

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
});
