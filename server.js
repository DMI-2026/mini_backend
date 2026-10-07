import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const DRINKS = ["espresso", "americano", "latte", "cappuccino", "mocha"];
const SIZES = ["S", "M", "L"];
const TRANSITIONS = {
  pending: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["delivered"],
  delivered: [],
  cancelled: [],
};

class HttpError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : "Validation error");
    this.status = status;
    this.detail = detail;
  }
}

// Same 422 shape as FastAPI, which the Flutter client parses per field.
const invalid = (where, field, msg) => new HttpError(422, [{ loc: [where, field], msg }]);

export function openDb(path = process.env.DB_PATH ?? "app.db") {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT NOT NULL,
      drink TEXT NOT NULL,
      size TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);
  return db;
}

// Validates only the fields present in body; `required` lists the mandatory ones.
function validate(body, required) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("body", "body", "Body must be a JSON object");
  }
  const out = {};
  for (const key of required) {
    if (body[key] == null) throw invalid("body", key, "Field required");
  }
  if (body.customer != null) {
    const c = typeof body.customer === "string" ? body.customer.trim() : "";
    if (c.length < 1 || c.length > 50) throw invalid("body", "customer", "Must be 1-50 characters");
    out.customer = c;
  }
  const enums = { drink: DRINKS, size: SIZES, status: Object.keys(TRANSITIONS) };
  for (const [key, allowed] of Object.entries(enums)) {
    if (body[key] == null) continue;
    if (!allowed.includes(body[key])) throw invalid("body", key, `Must be one of: ${allowed.join(", ")}`);
    out[key] = body[key];
  }
  return out;
}

function getOr404(db, id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, `Order ${id} not found`);
  return row;
}

function parseId(raw) {
  if (!/^-?\d+$/.test(raw)) throw invalid("path", "order_id", "Must be an integer");
  return Number(raw);
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  try {
    return JSON.parse(data);
  } catch {
    throw invalid("body", "body", "Invalid JSON");
  }
}

// Dev knobs so clients can reproduce loading and error states on demand.
async function simulate(params) {
  const delay = params.has("delay") ? Number(params.get("delay")) : 0;
  const fail = params.has("fail") ? Number(params.get("fail")) : null;
  if (!(delay >= 0 && delay <= 10)) throw invalid("query", "delay", "Must be between 0 and 10");
  if (fail !== null && !(Number.isInteger(fail) && fail >= 400 && fail <= 599)) {
    throw invalid("query", "fail", "Must be an integer between 400 and 599");
  }
  await new Promise((r) => setTimeout(r, delay * 1000));
  if (fail) throw new HttpError(fail, "Simulated failure");
}

async function route(db, req, url) {
  await simulate(url.searchParams);
  const [, resource, rawId, extra] = url.pathname.split("/");
  const m = req.method;

  if (resource === "health" && !rawId && m === "GET") {
    db.prepare("SELECT 1").get();
    return [200, { status: "ok" }];
  }
  if (resource !== "orders" || extra !== undefined) throw new HttpError(404, "Not Found");

  if (!rawId) {
    if (m === "GET") return [200, db.prepare("SELECT * FROM orders ORDER BY id DESC").all()];
    if (m === "POST") {
      const o = validate(await readJson(req), ["customer", "drink", "size"]);
      const row = db
        .prepare("INSERT INTO orders (customer, drink, size) VALUES (?, ?, ?) RETURNING *")
        .get(o.customer, o.drink, o.size);
      return [201, row];
    }
    throw new HttpError(405, "Method Not Allowed");
  }

  const id = parseId(rawId);
  if (m === "GET") return [200, getOr404(db, id)];
  if (m === "DELETE") {
    if (db.prepare("DELETE FROM orders WHERE id = ?").run(id).changes === 0) {
      throw new HttpError(404, `Order ${id} not found`);
    }
    return [204, null];
  }
  if (m === "PATCH") {
    const changes = validate(await readJson(req), []);
    const current = getOr404(db, id).status;
    if (changes.status && !TRANSITIONS[current].includes(changes.status)) {
      throw new HttpError(409, `Cannot change status from ${current} to ${changes.status}`);
    }
    if (Object.keys(changes).some((k) => k !== "status") && current !== "pending") {
      throw new HttpError(409, `Cannot edit an order that is ${current}`);
    }
    const cols = Object.keys(changes);
    if (cols.length) {
      // Column names come from validate(), never from user input.
      const sets = cols.map((c) => `${c} = ?`).join(", ");
      db.prepare(`UPDATE orders SET ${sets} WHERE id = ?`).run(...Object.values(changes), id);
    }
    return [200, getOr404(db, id)];
  }
  throw new HttpError(405, "Method Not Allowed");
}

export function createServer(db = openDb()) {
  return http.createServer(async (req, res) => {
    let status, body;
    try {
      [status, body] = await route(db, req, new URL(req.url, "http://localhost"));
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      [status, body] = err instanceof HttpError ? [err.status, { detail: err.detail }] : [500, { detail: "Internal Server Error" }];
    }
    if (status === 204) return res.writeHead(204).end();
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8000);
  const host = process.env.HOST ?? "0.0.0.0";
  createServer().listen(port, host, () => console.log(`Listening on http://${host}:${port}`));
}
