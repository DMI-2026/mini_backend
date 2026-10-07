import asyncio
import os
import sqlite3
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, status
from pydantic import BaseModel, StringConstraints

DB_PATH = os.getenv("DB_PATH", "app.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer TEXT NOT NULL,
    drink TEXT NOT NULL,
    size TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""


class Drink(StrEnum):
    ESPRESSO = "espresso"
    AMERICANO = "americano"
    LATTE = "latte"
    CAPPUCCINO = "cappuccino"
    MOCHA = "mocha"


class Size(StrEnum):
    S = "S"
    M = "M"
    L = "L"


class Status(StrEnum):
    PENDING = "pending"
    PREPARING = "preparing"
    READY = "ready"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


TRANSITIONS: dict[Status, set[Status]] = {
    Status.PENDING: {Status.PREPARING, Status.CANCELLED},
    Status.PREPARING: {Status.READY, Status.CANCELLED},
    Status.READY: {Status.DELIVERED},
    Status.DELIVERED: set(),
    Status.CANCELLED: set(),
}

Customer = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]


class OrderIn(BaseModel):
    customer: Customer
    drink: Drink
    size: Size


class OrderPatch(BaseModel):
    customer: Customer | None = None
    drink: Drink | None = None
    size: Size | None = None
    status: Status | None = None


class Order(OrderIn):
    id: int
    status: Status
    created_at: datetime


@asynccontextmanager
async def lifespan(app: FastAPI):
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)
    yield


def get_db() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:  # commits on success, rolls back on exception
            yield conn
    finally:
        conn.close()


async def simulate(
    delay: Annotated[float, Query(ge=0, le=10, description="Seconds to wait before responding")] = 0,
    fail: Annotated[int | None, Query(ge=400, le=599, description="Force this HTTP error code")] = None,
):
    """Dev knobs so clients can reproduce loading and error states on demand."""
    await asyncio.sleep(delay)
    if fail:
        raise HTTPException(fail, "Simulated failure")


Db = Annotated[sqlite3.Connection, Depends(get_db)]

app = FastAPI(lifespan=lifespan, dependencies=[Depends(simulate)])


def get_or_404(db: sqlite3.Connection, order_id: int) -> dict:
    row = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Order {order_id} not found")
    return dict(row)


@app.get("/health")
def health(db: Db):
    db.execute("SELECT 1")
    return {"status": "ok"}


@app.get("/orders", response_model=list[Order])
def list_orders(db: Db):
    return [dict(r) for r in db.execute("SELECT * FROM orders ORDER BY id DESC")]


@app.get("/orders/{order_id}", response_model=Order)
def get_order(order_id: int, db: Db):
    return get_or_404(db, order_id)


@app.post("/orders", response_model=Order, status_code=status.HTTP_201_CREATED)
def create_order(order: OrderIn, db: Db):
    row = db.execute(
        "INSERT INTO orders (customer, drink, size) VALUES (?, ?, ?) RETURNING *",
        (order.customer, order.drink, order.size),
    ).fetchone()
    return dict(row)


@app.patch("/orders/{order_id}", response_model=Order)
def update_order(order_id: int, patch: OrderPatch, db: Db):
    current = Status(get_or_404(db, order_id)["status"])
    changes = patch.model_dump(exclude_none=True)

    new_status = changes.get("status")
    if new_status and new_status not in TRANSITIONS[current]:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Cannot change status from {current} to {new_status}")
    if changes.keys() - {"status"} and current != Status.PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Cannot edit an order that is {current}")

    if changes:
        # Column names come from OrderPatch fields, never from user input.
        sets = ", ".join(f"{col} = ?" for col in changes)
        db.execute(f"UPDATE orders SET {sets} WHERE id = ?", (*changes.values(), order_id))
    return get_or_404(db, order_id)


@app.delete("/orders/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_order(order_id: int, db: Db):
    if db.execute("DELETE FROM orders WHERE id = ?", (order_id,)).rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Order {order_id} not found")
