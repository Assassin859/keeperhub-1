import { check, sleep } from "k6";
import { post, adminGet } from "./http.js";

export function registerAndLogin(vuId) {
  const timestamp = Date.now();
  const email = `k6-vu${vuId}-${timestamp}@techops.services`;
  const password = "K6LoadTest!2024";
  const name = `k6-user-${vuId}`;

  // Step 1: Sign up
  const signUpRes = post("/api/auth/sign-up/email", {
    email,
    password,
    name,
  });

  const signUpOk = check(signUpRes, {
    "signup: status 200": (r) => r.status === 200,
  });

  if (!signUpOk) {
    console.error(
      `Signup failed for ${email}: ${signUpRes.status} ${signUpRes.body}`
    );
    return null;
  }

  // Step 2: Retrieve OTP via admin endpoint (with retries)
  let otp = null;
  const maxRetries = 8;

  for (let i = 0; i < maxRetries; i++) {
    const otpRes = adminGet(
      `/api/admin/test/otp?email=${encodeURIComponent(email)}`
    );

    if (otpRes.status === 200) {
      const body = JSON.parse(otpRes.body);
      otp = body.otp;
      break;
    }

    if (otpRes.status !== 404) {
      console.error(
        `OTP retrieval error for ${email}: ${otpRes.status} ${otpRes.body}`
      );
      return null;
    }

    const delay = Math.min(0.5 * Math.pow(2, i), 4);
    sleep(delay);
  }

  if (!otp) {
    console.error(`No OTP found for ${email} after ${maxRetries} retries`);
    return null;
  }

  // Step 3: Verify email with OTP
  const verifyRes = post("/api/auth/email-otp/verify-email", {
    email,
    otp,
  });

  const verifyOk = check(verifyRes, {
    "verify: status 200": (r) => r.status === 200,
  });

  if (!verifyOk) {
    console.error(
      `Email verification failed for ${email}: ${verifyRes.status} ${verifyRes.body}`
    );
    return null;
  }

  // Step 4: Sign in
  const signInRes = post("/api/auth/sign-in/email", {
    email,
    password,
  });

  const signInOk = check(signInRes, {
    "signin: status 200": (r) => r.status === 200,
  });

  if (!signInOk) {
    console.error(
      `Sign-in failed for ${email}: ${signInRes.status} ${signInRes.body}`
    );
    return null;
  }

  // Step 5: Create an API key for webhook testing
  let apiKey = null;
  const apiKeyRes = post("/api/api-keys", { name: `k6-test-vu${vuId}` });
  const apiKeyOk = check(apiKeyRes, {
    "api-key create: status 200": (r) => r.status === 200,
  });

  if (apiKeyOk) {
    const apiKeyBody = JSON.parse(apiKeyRes.body);
    apiKey = apiKeyBody.key;
  } else {
    console.error(
      `API key creation failed for ${email}: ${apiKeyRes.status} ${apiKeyRes.body}`
    );
  }

  return { email, password, apiKey };
}
