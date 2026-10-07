# Mini Backend — Coffee Orders API

A small FastAPI + SQLite API for managing coffee shop orders. It is built to be consumed by a Flutter client and includes switches for simulating latency and errors, so every loading, empty, success and error state can be reproduced on demand.

## Quick start

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync                      # install dependencies
uv run fastapi dev main.py   # http://127.0.0.1:8000
uv run pytest                # run tests
```

Interactive docs: `http://127.0.0.1:8000/docs`

| Setting   | Default  | Description                   |
|-----------|----------|-------------------------------|
| `DB_PATH` | `app.db` | Path to the SQLite database file. |

The `orders` table is created automatically on startup.

> **Android emulator:** the host machine is reachable at `http://10.0.2.2:8000`, not `localhost`.

## Order model

```json
{
  "id": 1,
  "customer": "Ana",
  "drink": "latte",
  "size": "M",
  "status": "pending",
  "created_at": "2026-10-07T18:30:00Z"
}
```

| Field        | Type     | Values / rules                                              |
|--------------|----------|-------------------------------------------------------------|
| `id`         | int      | Assigned by the server.                                     |
| `customer`   | string   | 1–50 characters; surrounding whitespace is trimmed.         |
| `drink`      | enum     | `espresso`, `americano`, `latte`, `cappuccino`, `mocha`     |
| `size`       | enum     | `S`, `M`, `L`                                               |
| `status`     | enum     | `pending`, `preparing`, `ready`, `delivered`, `cancelled`   |
| `created_at` | datetime | ISO 8601, UTC. Assigned by the server.                      |

### Status lifecycle

```
pending ──► preparing ──► ready ──► delivered
   │            │
   └──► cancelled ◄┘
```

- Only the transitions shown above are allowed. Anything else returns `409 Conflict`.
- `delivered` and `cancelled` are final.
- `customer`, `drink` and `size` can only be edited while the order is `pending`.

## Endpoints

| Method | Path                 | Description                     | Success | Errors             |
|--------|----------------------|---------------------------------|---------|--------------------|
| GET    | `/health`            | Health check, including the DB. | 200     |                    |
| GET    | `/orders`            | List orders, newest first.      | 200     |                    |
| GET    | `/orders/{id}`       | Get one order.                  | 200     | 404                |
| POST   | `/orders`            | Create an order.                | 201     | 422                |
| PATCH  | `/orders/{id}`       | Edit fields and/or change status. | 200   | 404, 409, 422      |
| DELETE | `/orders/{id}`       | Delete an order.                | 204     | 404                |

### Examples

```bash
# Create
curl -X POST localhost:8000/orders \
  -H 'Content-Type: application/json' \
  -d '{"customer": "Ana", "drink": "latte", "size": "M"}'

# Advance status
curl -X PATCH localhost:8000/orders/1 \
  -H 'Content-Type: application/json' \
  -d '{"status": "preparing"}'

# Edit (only while pending)
curl -X PATCH localhost:8000/orders/1 \
  -H 'Content-Type: application/json' \
  -d '{"size": "L"}'
```

`PATCH` accepts any subset of `customer`, `drink`, `size` and `status`.

## Simulating client states

Every endpoint accepts two optional query parameters:

| Param   | Range     | Effect                                         |
|---------|-----------|------------------------------------------------|
| `delay` | 0–10      | Wait this many seconds before responding.      |
| `fail`  | 400–599   | Respond with this HTTP status code instead.    |

Both parameters can be used together: `?delay=2&fail=500` waits 2 s and then fails.

| Client state      | How to trigger it                              |
|-------------------|------------------------------------------------|
| Loading           | `GET /orders?delay=3`                          |
| Success           | Any normal request.                            |
| Empty             | `GET /orders` with no orders in the database.  |
| Network/server error | `GET /orders?fail=500` (or `503`, …)        |
| Not found         | `GET /orders/999`                              |
| Validation error  | `POST /orders` with `"customer": ""`           |
| Business conflict | `PATCH` a `delivered` order to `preparing`     |

## Error format

Errors use two different shapes, and the client must handle both:

```json
// 404, 409 and simulated errors
{ "detail": "Order 999 not found" }

// 422 validation errors
{
  "detail": [
    { "type": "string_too_short", "loc": ["body", "customer"], "msg": "String should have at least 1 character", "input": "" }
  ]
}
```

## Not included

- **Authentication:** every endpoint is public.
- **CORS:** needed only for Flutter web.
- **Pagination and filtering:** `GET /orders` returns every order.
