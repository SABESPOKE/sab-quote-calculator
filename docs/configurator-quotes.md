# Paid website orders → Quote Calculator

When a website order is **paid**, the configurator creates a quote for it in the Quote
Calculator (QC). The quote has status `sold`, source `configurator`, `locked: true`, and
carries the paid figures.

QC never prices, reprices or re-totals that quote. Its totals are the paid figures,
exactly, everywhere they show: the list, Build, Margin, Client View and PDF. Nobody can
edit it in QC; only its status can change (Active, Sold, Lost or Archive, or the Deleted
folder). That rule is enforced on the server.

## Request

```
PUT /api/quotes/cfg-<orderId>
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

- `<orderId>` is the website's own order id, so the same order always maps to the same
  quote id.
- **The request is idempotent.** Sending the same body again (a retry) answers `200` and
  still leaves exactly one quote.
- Do **not** send an `X-Pricing-Engine` header. It belongs to the calculator itself.
- `API_TOKEN` is the token already used for `POST /api/cabinet-cost`.

## Body

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `cfg-<orderId>`. Must equal the id in the URL. |
| `locked` | boolean | yes | `true`. This is what makes the quote a website order. |
| `source` | string | yes | `"configurator"` |
| `status` | string | yes | `"sold"` |
| `client` | string | yes | Client name. QC groups quotes by this. |
| `project` | string | yes | For example `"Website order #1042 — utility run"`. |
| `ref` | string | yes | For example `"WEB-1042"`. Shown on the quote and the PDF. |
| `created` | string | yes | Order date as `DD/MM/YYYY`. Shown in the list. |
| `updated_at` | string | recommended | ISO 8601 time the order was paid. |
| `paid` | object | yes | The paid figures. See below. |
| `rooms` | object | yes | `{ "<room name>": { "includeDesignTime": false, "items": [ … ] } }`, with at least one room. `includeDesignTime` must be `false` (website orders carry no design fee). |

### `paid`

All amounts are in £. Send them as JSON numbers, not strings, each ≥ 0 and with at most
2 decimal places.

| Field | Meaning | Rule |
|---|---|---|
| `exVat` | Total ex VAT | Must equal the sum of the items' `pricing.totalSellExVAT`. |
| `vat` | VAT charged | |
| `gross` | Total inc VAT | `exVat + vat` |
| `deposit` | Amount taken at checkout | |
| `balance` | Amount still to pay | `deposit + balance` = `gross` |

### Items (`rooms.<name>.items[]`)

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"cabinet"`, `"endpanel"`, or `"custom"` for anything else (delivery, discount, …). |
| `description` | string | The line as the client saw it. |
| `qty` | integer ≥ 1 | |
| `params` | object | For a cabinet or end panel: the engine-native params you priced it with (the body you sent to `POST /api/cabinet-cost` or `/api/endpanel-cost`, without `qty`). QC shows W × H × D from `widthMm` / `heightMm` / `depthMm`. Use `{}` for anything else. |
| `pricing` | object | **Required:** `totalSellExVAT` (number), the line total ex VAT. Also send `totalCost`, `totalSellIncVAT`, `costPerUnit` and `sellPerUnit`, or simply the whole `/api/cabinet-cost` response, which also gives QC the cost breakdown. |

A discount is a `custom` line with a negative `totalSellExVAT`. The lines must still add
up to `paid.exVat`.

### Workshop hours (QC adds them; don't send them)

When QC stores a new order, it computes each item's workshop hours once, from the item's
`type` and `params`, using the same engine as a normal quote. It writes them into that
item's `pricing.breakdown`, per unit, as `totalHrs`, `assemblyHrs`, `doorHrs`,
`drawerHrs`, `drawerFrontHrs`, `frameHrs`, `edgebandHrs`, `finishHrs`,
`carcassFinishHrs`, `labourHours`, `panelHrs`, `shelfHrs`, `mouldingHrs` and
`sprayDetail`. Each item type gets the fields that apply to it. These are what the
Orchestrator schedules the workshop from.

- Prices, totals and `paid` are untouched.
- A re-send never recomputes the hours, and any hour fields in a write are ignored.
- Items the engine can't price (`custom` lines) carry no hours.

### Supply only (QC sets it)

A website order has no installation. When QC creates one, it sets
`projectCosts.installDaysByRoom` to `0` for every room, replacing anything sent there.
Like the hours, this is set once and never changed by a re-send.

### Materials list (QC adds it; don't send it)

When QC creates the order, it builds `materialsBom` once from the items. It's the same
bill of materials QC serves for a normal quote: groups `carcass`, `doors`,
`drawerBoxes`, `frames`, `edgeband`, `hardware` and `handles`, each row with a `key`
plus `count` / `target` / `sheets` / `areaM2` / `linealM`. A re-send never rebuilds or
changes it.

Why the lines must add up: the Client View and the PDF total the lines and add VAT at the
rate in QC's Settings (20% today). When the lines sum to `exVat` and `vat` is that rate
of it, those two views show exactly the paid figures. Build, Margin and the list always
show `paid` itself.

### Fields not to send

Leave these out: `pricingLock`, `projectCosts`, `marginOverride`, `totalSellExVAT` and
`totalSellIncVAT`. QC sets the last two from `paid`, and sets
`projectCosts.installDaysByRoom` itself (see Supply only).

## Responses

| Status | Body | Meaning | What to do |
|---|---|---|---|
| `200` | `{ "ok": true }` | Stored. Also the answer to a same-body retry. | Done. |
| `400` | `{ "error": "Not a valid website order — see docs/configurator-quotes.md", "errors": [ … ] }` | Nothing was stored. Every problem is listed. | Fix the body, then send again. |
| `409` | `{ "error": "This quote is a paid website order and is locked — only its status can change (refused: <field>)." }` | `cfg-<orderId>` already exists with different content. QC never changes a paid order. | Don't retry. Alert a person. |
| `401` | `{ "error": "unauthorized" }` | The token is missing or wrong. | |
| `503` | `{ "error": "No database" }` or `{ "error": "Pricing engine not loaded — send the order again shortly" }` | QC can't store the order (with its hours) right now. | Retry later. |

## Example

```json
{
  "id": "cfg-1042",
  "source": "configurator",
  "status": "sold",
  "locked": true,
  "client": "Jane Example",
  "project": "Website order #1042 — utility run",
  "ref": "WEB-1042",
  "created": "26/10/2026",
  "updated_at": "2026-10-26T14:05:00.000Z",
  "paid": { "exVat": 1250.00, "vat": 250.00, "gross": 1500.00, "deposit": 750.00, "balance": 750.00 },
  "rooms": {
    "Utility": {
      "includeDesignTime": false,
      "items": [
        {
          "type": "cabinet",
          "description": "Base cabinet 600×720×560 — Shaker painted, 2 doors",
          "qty": 2,
          "params": { "widthMm": 600, "heightMm": 720, "depthMm": 560, "carcassMaterialKey": "MAT_BIRCH_PREF_18", "carcassFinish": "none", "doorCount": 2, "doorType": "SHAKER_PNT", "shelfCount": 1, "hingeKey": "HW_HINGE_SM", "handleKey": "HW_HDL_NONE" },
          "pricing": { "costPerUnit": 297.50, "sellPerUnit": 595.00, "totalCost": 595.00, "totalSellExVAT": 1190.00, "totalSellIncVAT": 1428.00 }
        },
        {
          "type": "custom",
          "description": "Delivery",
          "qty": 1,
          "params": {},
          "pricing": { "costPerUnit": 60.00, "sellPerUnit": 60.00, "totalCost": 60.00, "totalSellExVAT": 60.00, "totalSellIncVAT": 72.00 }
        }
      ]
    }
  }
}
```

This exact body is the fixture the QC tests run against (`test/fixtures/website-order.json`,
checked by `test/locked-quotes.test.js`).

## Reading it back

`GET /api/quotes` returns the order exactly as stored, plus `_serverUpdatedAt`,
`totalSellExVAT = paid.exVat` and `totalSellIncVAT = paid.gross`. That includes the
workshop hours, supply-only install days and materials list stored when the order was
created. QC never reprices a website order and adds no read-time annotations to it.

A paid order can be moved to QC's Deleted folder and restored, but it can never be
permanently deleted.
