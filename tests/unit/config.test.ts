import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";

const base = {
  DATABASE_URL: "postgres://colony:colony@localhost:5433/ai_colony",
};

describe("configuration", () => {
  it("defaults authentication to disabled", () => {
    const config = loadConfig(base);
    expect(config.authMode).toBe("disabled");
    expect(config.port).toBe(3000);
  });

  it("refuses development authentication in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "development" })).toThrow(
      /AUTH_MODE=development cannot be used/,
    );
  });

  it("fail-closes production when development auth is not configured", () => {
    const config = loadConfig({ ...base, NODE_ENV: "production" });
    expect(config.authMode).toBe("disabled");
  });

  it("allows development authentication outside production", () => {
    const config = loadConfig({ ...base, NODE_ENV: "development", AUTH_MODE: "development" });
    expect(config.authMode).toBe("development");
  });
});
