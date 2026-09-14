/**
 * A valid `AgentConfig` for tests, built through `loadConfig` rather than by hand.
 *
 * Constructing the object literally would let a test keep passing after a required
 * field was added to the schema — the tests would be exercising a config shape the
 * container can no longer produce. Going through the real loader means the fixture
 * fails the moment the contract changes.
 */

import { loadConfig, type AgentConfig } from "../../src/config.js";

const MINIMUM: NodeJS.ProcessEnv = {
  MODEL_BASE_URL: "https://provider.test/v1",
  MODEL_API_KEY: "sk-test",
  DATA_API_URL: "https://worker.test/data",
  DATA_API_TOKEN: "token",
};

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AgentConfig {
  return loadConfig({ ...MINIMUM, ...overrides });
}
