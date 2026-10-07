import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, openDb } from "./server.js";

let server, base;
beforeEach(async () => {
  server = createServer(openDb(":memory:")).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
afterEach(() => server.close());

const req = (path, method = "GET", body) =>
  fetch(base + path, { method, body: body && JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const create = (overrides = {}) => req("/orders", "POST", { customer: "Ana", drink: "latte", size: "M", ...overrides });

test("crud flow", async () => {
  assert.deepEqual(await (await req("/orders")).json(), []);
  const r = await create();
  assert.equal(r.status, 201);
  const order = await r.json();
  assert.equal(order.status, "pending");
  assert.deepEqual(await (await req(`/orders/${order.id}`)).json(), order);
  assert.equal((await (await req(`/orders/${order.id}`, "PATCH", { size: "L" })).json()).size, "L");
  assert.equal((await req(`/orders/${order.id}`, "DELETE")).status, 204);
  assert.equal((await req(`/orders/${order.id}`)).status, 404);
});

test("validation", async () => {
  assert.equal((await create({ customer: "   " })).status, 422);
  assert.equal((await create({ drink: "tea" })).status, 422);
  const r = await create({ drink: "tea" });
  assert.deepEqual((await r.json()).detail[0].loc, ["body", "drink"]);
});

test("status lifecycle", async () => {
  const url = `/orders/${(await (await create()).json()).id}`;
  assert.equal((await req(url, "PATCH", { status: "ready" })).status, 409);
  for (const s of ["preparing", "ready", "delivered"]) {
    assert.equal((await (await req(url, "PATCH", { status: s })).json()).status, s);
  }
  assert.equal((await req(url, "PATCH", { status: "cancelled" })).status, 409);
  assert.equal((await req(url, "PATCH", { drink: "mocha" })).status, 409);
});

test("simulate", async () => {
  assert.equal((await req("/orders?fail=503")).status, 503);
  assert.equal((await req("/orders?fail=200")).status, 422);
  assert.equal((await req("/orders?delay=0.1")).status, 200);
});
