import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", str(tmp_path / "test.db"))
    with TestClient(main.app) as c:
        yield c


def create(client, **overrides):
    body = {"customer": "Ana", "drink": "latte", "size": "M"} | overrides
    return client.post("/orders", json=body)


def test_crud_flow(client):
    assert client.get("/orders").json() == []

    r = create(client)
    assert r.status_code == 201
    order = r.json()
    assert order["status"] == "pending"

    assert client.get(f"/orders/{order['id']}").json() == order
    assert client.patch(f"/orders/{order['id']}", json={"size": "L"}).json()["size"] == "L"
    assert client.delete(f"/orders/{order['id']}").status_code == 204
    assert client.get(f"/orders/{order['id']}").status_code == 404


def test_validation(client):
    assert create(client, customer="   ").status_code == 422
    assert create(client, drink="tea").status_code == 422


def test_status_lifecycle(client):
    oid = create(client).json()["id"]
    url = f"/orders/{oid}"

    assert client.patch(url, json={"status": "ready"}).status_code == 409  # skips preparing
    for s in ["preparing", "ready", "delivered"]:
        assert client.patch(url, json={"status": s}).json()["status"] == s
    assert client.patch(url, json={"status": "cancelled"}).status_code == 409
    assert client.patch(url, json={"drink": "mocha"}).status_code == 409  # only pending is editable


def test_simulate(client):
    assert client.get("/orders?fail=503").status_code == 503
    assert client.get("/orders?fail=200").status_code == 422
    assert client.get("/orders?delay=0.1").status_code == 200
