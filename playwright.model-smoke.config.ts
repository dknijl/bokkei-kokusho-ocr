import baseConfig from "./playwright.config.ts";

export default {
  ...baseConfig,
  testDir: "./tests/model-smoke",
};
