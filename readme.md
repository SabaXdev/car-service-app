# Car Service Management

A Tbilisi workshop records every customer visit as a service order so advisors, mechanics, and administrators share one picture of the job. Service advisors register customers and vehicles, open orders, add labor and parts, and move work through open, in progress, completed, and cancelled. Mechanics see only the orders assigned to them and can start or complete that work. Administrators manage the full catalog, including which mechanics exist and who may sign in as one. The problem is keeping status, mileage, and money consistent: labor and parts roll up to a GEL total, and that total is shown in euro using an official lari exchange rate. The model has five entities: Customers, Vehicles, Mechanics, ServiceOrders, and ServiceItems.

## Run

From the project root:

```bash
npm install
npm run watch
```

Run automated smoke tests (in-memory SQLite, mocked auth):

```bash
npm test
```

`npm start` serves the same application without file watching. Development authentication is mocked. The sign-in prompt accepts the users in the table below.

| URL | What it is |
| --- | --- |
| http://localhost:4004 | CAP index, with links to the service and the UI |
| http://localhost:4004/odata/v4/CarService/ | OData V4 service root |
| http://localhost:4004/odata/v4/CarService/$metadata | Service metadata |
| http://localhost:4004/serviceorders/webapp/index.html | Fiori Elements List Report and Object Page |

On Windows PowerShell, call `curl.exe` rather than `curl`. PowerShell aliases `curl` to `Invoke-WebRequest`.

Restarting `cds watch` after a change under `db/data` reloads the SQLite database from those CSV files. Rows created only in the local database are replaced by the seed.

## Users and authorization

| User | Password | Role | What they can do |
| --- | --- | --- | --- |
| `admin` | `admin` | Admin | Full access to every entity and every action |
| `advisor` | `advisor` | ServiceAdvisor | Create, read, update, and delete customers, vehicles, service items, and service orders. Read mechanics. Start, complete, cancel, and refresh the exchange rate |
| `mechanic1` | `mechanic` | Mechanic | Read customers, vehicles, mechanics, and service items (no line-item edits). Read service orders only when the assigned mechanic’s `authUser` equals `mechanic1`. Start and complete those orders |

Cancel and Refresh FX Rate are not granted to the Mechanic role.

The browser keeps basic-auth credentials. Use a private window when you switch from `advisor` to `mechanic1`.

### Mechanic logins and row-level visibility

Mechanic authorization is **not** “see every order assigned to my name in the UI.” OData applies  
`mechanic.authUser = $user.id` on `ServiceOrders` (`srv/car-service.cds`). Only mechanics with a matching `authUser` in seed data participate in that filter.

| Mechanic (seed) | `authUser` in CSV | Mock login | Service orders visible to Mechanic role | Why |
| --- | --- | --- | --- | --- |
| Ana Mchedlishvili | `mechanic1` | `mechanic1` / `mechanic` | **SO-2026-0001** only | Order’s `mechanic_ID` points to Ana; her `authUser` matches the login |
| Dato Kapanadze | *(empty)* | *(none)* | **None** | SO-2026-0002 is assigned to Dato, but empty `authUser` never matches any `$user.id` |
| Levan Chkheidze | *(empty)* | *(none)* | **None** | SO-2025-0010 is assigned to Levan, but empty `authUser` never matches any `$user.id` |

To give another mechanic a login, set `authUser` on that row in `db/data/com.carservice-Mechanics.csv` and add a matching user under `cds.requires.auth.users` in `package.json` (development profile only).

## Exchange rates

Costs are stored in GEL. Frankfurter and the other ECB feeds do not quote the lari, so euro amounts come from the National Bank of Georgia:

`https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?currencies=EUR`

NBG publishes how many GEL buy one euro. The service stores the inverse on `exchangeRate` (euro per 1 GEL), and:

`totalCostEUR = round(totalCostGEL × exchangeRate, 2)`

The seed orders use the rate **0.336462** (NBG quote 2.9721 GEL per EUR, valid from 2026-09-26):

| Order | GEL total | EUR total |
| --- | --- | --- |
| SO-2026-0001 | 850.00 | 285.99 |
| SO-2026-0002 | 0.00 | 0.00 |
| SO-2025-0010 | 185.00 | 62.25 |

If the National Bank request fails, the service tries ExchangeRate-API (`https://open.er-api.com/v6/latest/GEL`) and warns that the fallback was used. If both fail, `exchangeRate` and `totalCostEUR` are cleared and the request warns: "Exchange rate unavailable; EUR total was not calculated." A successful rate is reused for 15 minutes. **Refresh FX Rate** always requests a new quote.

Creating, updating, or deleting a service item recalculates `laborCost`, `partsCost`, `totalCostGEL`, `exchangeRate`, and `totalCostEUR` together. The Object Page reloads those fields because `items` declares them as side-effect targets in `srv/car-service.cds`.

## Demo script

Walk the code in this order, then the UI.

1. `db/schema.cds` — five entities, associations, and the `ServiceOrders` to `ServiceItems` composition.
2. `srv/car-service.cds` — OData V4 service `CarService`, draft on service orders, actions, and `@restrict`.
3. `srv/car-service.js` — date and mileage checks, line totals, status actions, and total recalculation.
4. `srv/lib/exchange-rates.js` — National Bank of Georgia rate, with the ExchangeRate-API fallback.
5. `srv/car-service-ui.cds` and `app/serviceorders/webapp/manifest.json` — List Report and Object Page.

Then, signed in as `advisor` / `advisor`:

1. Open the Fiori URL. The list shows customer, vehicle, status, and the GEL total. SO-2026-0001 is in progress for Ana Mchedlishvili.
2. Open SO-2026-0001. The object page shows customer and vehicle, service items, and the cost summary: labor 250.00, parts 600.00, total 850.00 GEL, EUR equivalent 285.99, exchange rate 0.336462. Refresh FX Rate may replace the rate if the National Bank has published a newer quote; the EUR total follows that rate.
3. Choose **Create**. Set the service date to yesterday and fill customer, vehicle, and mileage. Save. The service rejects it: "Service date cannot be in the past."
4. Open SO-2026-0002, edit it, and set mileage at service below the vehicle's current mileage. Save. The service rejects it and reports both figures.
5. On an open order, add a labor line with hours and an hourly rate. After save, the line total, labor, parts, GEL total, exchange rate, and EUR total all update together. You do not need a separate refresh for that save.
6. Choose **Refresh FX Rate**. `exchangeRate` and `totalCostEUR` are loaded again. The same action on a cancelled order is rejected.

Signed in as `mechanic1` / `mechanic`:

1. The list contains **SO-2026-0001** only (see table above). SO-2026-0002 and SO-2025-0010 are hidden—not because the role lacks read access in general, but because Dato and Levan have no `authUser` linked to this login.
2. **Start Service** and **Complete Service** are available on that order. **Cancel Service**, **Refresh FX Rate**, and editing service line items are not available to the Mechanic role.

OData checks with `advisor`:

```bash
curl.exe -u advisor:advisor "http://localhost:4004/odata/v4/CarService/ServiceOrders?$select=orderNumber,status,totalCostGEL,totalCostEUR,exchangeRate"

curl.exe -u advisor:advisor -X POST -H "Content-Type: application/json" -d "{}" "http://localhost:4004/odata/v4/CarService/ServiceOrders(ID=33333333-3333-3333-3333-333333333301,IsActiveEntity=true)/CarServiceService.refreshExchangeRate"
```

The same GET with `mechanic1` / `mechanic` returns one order.

## Project layout

| Path | Role |
| --- | --- |
| `db/schema.cds` | Domain model |
| `db/data/` | CSV seed |
| `srv/car-service.cds` | Service, actions, authorization, readonly totals |
| `srv/car-service.js` | Validations, lifecycle, totals |
| `srv/lib/exchange-rates.js` | GEL to EUR |
| `srv/car-service-ui.cds` | Fiori annotations (labels via `{i18n>…}`) |
| `_i18n/i18n.properties` | CAP i18n for OData UI labels |
| `app/serviceorders/webapp/i18n/` | Fiori app i18n (mirrors UI label keys) |
| `app/serviceorders/` | Fiori Elements application |
| `package.json` | Dependencies, scripts, and mock users |
