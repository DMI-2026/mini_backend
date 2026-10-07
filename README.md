# Mini Backend: API de pedidos de cafetería

API pequeña en FastAPI + SQLite para gestionar los pedidos de una cafetería. Está pensada para usarse desde un cliente Flutter. Incluye parámetros para simular latencia y errores, así que cada estado del cliente (carga, vacío, éxito y error) se puede reproducir cuando se necesite.

## Inicio rápido

Requiere [uv](https://docs.astral.sh/uv/).

```bash
uv sync                      # instalar dependencias
uv run fastapi dev main.py   # http://127.0.0.1:8000
uv run pytest                # ejecutar los tests
```

Documentación interactiva: `http://127.0.0.1:8000/docs`

| Variable  | Valor por defecto | Descripción                                |
|-----------|-------------------|--------------------------------------------|
| `DB_PATH` | `app.db`          | Ruta del archivo de la base de datos SQLite. |

La tabla `orders` se crea automáticamente al arrancar.

> **Emulador de Android:** la máquina anfitriona se accede en `http://10.0.2.2:8000`, no en `localhost`.

## Modelo de pedido

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

| Campo        | Tipo     | Valores / reglas                                              |
|--------------|----------|---------------------------------------------------------------|
| `id`         | int      | Lo asigna el servidor.                                        |
| `customer`   | string   | De 1 a 50 caracteres. Se eliminan los espacios al inicio y al final. |
| `drink`      | enum     | `espresso`, `americano`, `latte`, `cappuccino`, `mocha`       |
| `size`       | enum     | `S`, `M`, `L`                                                 |
| `status`     | enum     | `pending`, `preparing`, `ready`, `delivered`, `cancelled`     |
| `created_at` | datetime | ISO 8601, en UTC. Lo asigna el servidor.                      |

### Ciclo de vida del estado

```
pending ──► preparing ──► ready ──► delivered
   │            │
   └──► cancelled ◄┘
```

- Solo se permiten las transiciones del diagrama. Cualquier otra responde `409 Conflict`.
- `delivered` y `cancelled` son estados finales.
- `customer`, `drink` y `size` solo se pueden editar mientras el pedido está en `pending`.

## Endpoints

| Método | Ruta           | Descripción                               | Éxito | Errores       |
|--------|----------------|-------------------------------------------|-------|---------------|
| GET    | `/health`      | Comprobación de salud, incluida la base de datos. | 200 |           |
| GET    | `/orders`      | Lista los pedidos, del más reciente al más antiguo. | 200 |         |
| GET    | `/orders/{id}` | Obtiene un pedido.                        | 200   | 404           |
| POST   | `/orders`      | Crea un pedido.                           | 201   | 422           |
| PATCH  | `/orders/{id}` | Edita campos y/o cambia el estado.        | 200   | 404, 409, 422 |
| DELETE | `/orders/{id}` | Elimina un pedido.                        | 204   | 404           |

### Ejemplos

```bash
# Crear
curl -X POST localhost:8000/orders \
  -H 'Content-Type: application/json' \
  -d '{"customer": "Ana", "drink": "latte", "size": "M"}'

# Avanzar el estado
curl -X PATCH localhost:8000/orders/1 \
  -H 'Content-Type: application/json' \
  -d '{"status": "preparing"}'

# Editar (solo en pending)
curl -X PATCH localhost:8000/orders/1 \
  -H 'Content-Type: application/json' \
  -d '{"size": "L"}'
```

`PATCH` acepta cualquier combinación de `customer`, `drink`, `size` y `status`.

## Simular estados del cliente

Todos los endpoints aceptan dos parámetros de query opcionales:

| Parámetro | Rango   | Efecto                                         |
|-----------|---------|------------------------------------------------|
| `delay`   | 0–10    | Espera esa cantidad de segundos antes de responder. |
| `fail`    | 400–599 | Responde con ese código HTTP en lugar del normal. |

Se pueden combinar: `?delay=2&fail=500` espera 2 s y luego falla.

| Estado del cliente      | Cómo provocarlo                                    |
|-------------------------|----------------------------------------------------|
| Carga                   | `GET /orders?delay=3`                              |
| Éxito                   | Cualquier petición normal.                         |
| Vacío                   | `GET /orders` sin pedidos en la base de datos.     |
| Error de red o servidor | `GET /orders?fail=500` (o `503`, …)                |
| No encontrado           | `GET /orders/999`                                  |
| Error de validación     | `POST /orders` con `"customer": ""`                |
| Conflicto de negocio    | `PATCH` de un pedido `delivered` a `preparing`     |

## Formato de errores

Los errores tienen dos formas distintas y el cliente debe manejar ambas:

```json
// 404, 409 y errores simulados
{ "detail": "Order 999 not found" }

// 422, errores de validación
{
  "detail": [
    { "type": "string_too_short", "loc": ["body", "customer"], "msg": "String should have at least 1 character", "input": "" }
  ]
}
```

Los mensajes de error que devuelve la API están en inglés.

## Estructura sugerida del cliente Flutter

MVVM organizado por feature:

```
lib/
  core/
    http_client.dart        # baseUrl, timeouts, ?delay/?fail para pruebas
    failure.dart            # sealed class de errores de la app
  features/
    orders/
      domain/
        order.dart          # Order + enums (Drink, Size, OrderStatus)
      data/
        order_repository.dart  # HTTP → JSON → Order, y HTTP error → Failure
      ui/
        orders_view_model.dart
        orders_screen.dart
        widgets/
          order_tile.dart
  main.dart                 # inyecta dependencias
```

## No incluido

- **Autenticación:** todos los endpoints son públicos.
- **CORS:** solo hace falta para Flutter web.
- **Paginación y filtros:** `GET /orders` devuelve todos los pedidos.
