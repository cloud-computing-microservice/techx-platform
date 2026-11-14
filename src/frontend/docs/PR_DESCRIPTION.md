# Issue #6 — frontend UI and documentation verification

## Scope and revisions

- Issue: https://github.com/cloud-computing-microservice/techx-platform/issues/6
- Base: `5b21550da852f61076ee07590622d30b07b41e93`.
- Restores the frontend improvements authored by conghungtran in PR #8, source
  head `c2c033fe2a19d82c218aaa44e764dbf691ced0bd`, with the corrections below.
- The replacement PR records its exact tested head and CI runs. The source
  changes are limited to `src/frontend/**`.

## Behavior

- Product details distinguish catalog failures from missing products and offer retry.
- Catalog filters provide Reset; the mobile drawer is excluded from keyboard
  navigation when closed, traps focus when open, and returns focus on Escape.
- Cart remove controls name the product; checkout adds required-field hints,
  field lengths, validation focus, disabled inputs during submission, and retry copy.
- The mobile checkout shows Review order above the form.
- Order lookup clears stale validation state on edit; confirmation failures offer retry.
- Loading states expose status semantics, and lookup results use a polite live region.
- The body font is preserved by removing an overriding `font: inherit` reset.
  The main content accepts programmatic focus for the keyboard skip link.
- Local and Docker builds use the same Webpack build script to avoid the
  Next.js 16.4.2 Turbopack Google font resolution failure.
- Plus Jakarta Sans is bundled with its SIL Open Font License and loaded via
  `next/font/local`; builds no longer depend on Google Fonts responses.
- README documents folder structure, routes, setup, server configuration,
  checks, screenshots, and browser → BFF → API flow. Store config correctly
  uses `ORDER_API_URL`, not `CATALOG_API_URL`.

## Environment and evidence

Verification date: 2026-11-14 (Asia/Ho_Chi_Minh).

| Item                  | Value                                                             |
| --------------------- | ----------------------------------------------------------------- |
| OS                    | Windows, PowerShell                                               |
| Node / npm            | 22.23.4 / 11.12.1                                                 |
| Next.js / React       | 16.4.2 / 19.2.8                                                   |
| Unit runner           | Vitest 4.1.12                                                     |
| Browser               | Chromium 141.0.7390.37, Playwright 1.56.1, clean headless context |
| Desktop / mobile      | 1280×900 / 390×844                                                |
| Frontend              | Production Webpack build on `http://127.0.0.1:3196`               |
| APIs                  | Real local Catalog and Order HTTP servers on 3197/3198            |
| Browser order storage | `FakeOrderRepository`, no claim of persistence verification       |

The browser checks exercise real BFF success paths. Transient failure/retry
states are deliberately injected as HTTP 503 responses in the browser harness.
The regular CI acceptance suite separately verifies DynamoDB Local and the
container stack, including resilience, recovery, soak and runtime audit.

Before screenshots in `screenshots/before/` are retained evidence from PR #8.
After screenshots in `screenshots/after/` are new captures of this corrected
production build. They show actual catalog data, a cart containing one product
with quantity two, a checkout with quantity one, and a newly created order.

## Checks and expected results

| Check                                       | Expected result                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run check -w @techx/frontend`          | TypeScript exit 0                                                       |
| `npm run test -w @techx/frontend`           | All UI, contract, BFF and accessibility tests pass                      |
| `npm run build -w @techx/frontend`          | Production Webpack build succeeds                                       |
| `npm run format:check` / `npm run lint`     | Exit 0                                                                  |
| Search/filter/reset, empty and error states | Correct catalog results and working retry                               |
| Add/update/remove cart                      | Quantity and totals update, empty state after removal                   |
| Checkout invalid/error/retry/success        | Focus first invalid field, preserve input/cart, create order            |
| Order lookup                                | Invalid ID rejected, error retry succeeds, details/history render       |
| Keyboard and mobile                         | Skip link focuses main, drawer traps/restores focus, summary above form |
| Layout and images                           | No horizontal overflow or broken images in captured screens             |
| BFF key boundary                            | App fetch/XHR stays same-origin; browser never sends upstream API key   |
| Production static assets                    | Build-time dummy API-key value absent from `.next/static`               |

Actual command and browser results are recorded in [verification.md](verification.md).
The checkout regression test also checks that a retry preserves the idempotency
key and that successful submission clears the cart.

## Screenshots

| Page     | Before                                             | After                                            |
| -------- | -------------------------------------------------- | ------------------------------------------------ |
| Catalog  | ![Before](screenshots/before/products-desktop.png) | ![After](screenshots/after/products-desktop.png) |
| Cart     | ![Before](screenshots/before/cart-desktop.png)     | ![After](screenshots/after/cart-desktop.png)     |
| Checkout | ![Before](screenshots/before/checkout-desktop.png) | ![After](screenshots/after/checkout-desktop.png) |
| Lookup   | ![Before](screenshots/before/orders-desktop.png)   | ![After](screenshots/after/orders-desktop.png)   |

Mobile: [catalog](screenshots/after/products-mobile.png),
[cart](screenshots/after/cart-mobile.png),
[checkout](screenshots/after/checkout-mobile.png),
[lookup result](screenshots/after/orders-result-mobile.png).

## Reproduction

Run the three required frontend commands above from the repository root.
For a complete local stack, follow `src/frontend/README.md` and run
`docker compose up -d --build --wait` with a sample local-only key.
Check the six pages at both viewport sizes, following the README manual
verification checklist. Use the documented BFF curl examples to inspect API
responses; the browser must call the same-origin `/api/*` endpoints.

Browser key-boundary verification used a dummy build/runtime key, inspected
HTML, JavaScript and API responses, and checked that no fetch/XHR request
contained the value or an `X-TechX-Api-Key` header. It also scanned all generated
`.next/static` files for the dummy value. No real credential was used.
