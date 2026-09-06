import { expect, test } from "bun:test";
import { hasInstanceAdmission } from "./instance-admission.ts";
const id = "10000000-0000-4000-8000-000000000001";
test("P2P room IDs alone do not authorize membership", async () => {
  expect(await hasInstanceAdmission({ get: async () => null, hexists: async () => 0 }, id, "visitor")).toBe(false);
});
test("API admission is scoped to exact instance and user", async () => {
  const redis = { get: async (key: string) => key === `instance:admission:${id}:host` ? "1" : null, hexists: async () => 0 };
  expect(await hasInstanceAdmission(redis, id, "host")).toBe(true);
  expect(await hasInstanceAdmission(redis, id, "visitor")).toBe(false);
});
test("a relay member may reconnect; Redis errors and malformed IDs fail closed", async () => {
  expect(await hasInstanceAdmission({ get: async () => null, hexists: async () => 1 }, id, "host")).toBe(true);
  expect(await hasInstanceAdmission({ get: async () => { throw Error("offline"); }, hexists: async () => 0 }, id, "host")).toBe(false);
  expect(await hasInstanceAdmission({ get: async () => "1", hexists: async () => 1 }, {}, "host")).toBe(false);
});
