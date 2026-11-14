# Verification results

Recorded on 2026-11-14. See [scope and environment](PR_DESCRIPTION.md).

## Frontend tests

```text
> @techx/frontend@0.1.0 test
> vitest run


 RUN  v4.1.12 <repo>/src/frontend


 Test Files  16 passed (16)
      Tests  49 passed (49)
   Start at  09:34:05
   Duration  9.68s (transform 1.59s, setup 13.30s, import 8.01s, tests 12.53s, environment 30.00s)
```

## Production build

```text
> @techx/frontend@0.1.0 build
> next build --webpack

▲ Next.js 16.4.2 (webpack)
✓ Running next.config.mjs took 26ms

  Creating an optimized production build ...
✓ Compiled successfully in 3.2s
  Running TypeScript ...
  Finished TypeScript in 2.7s ...
  Collecting page data using 11 workers ...
  Generating static pages using 11 workers (0/12) ...
  Generating static pages using 11 workers (3/12)
  Generating static pages using 11 workers (6/12)
  Generating static pages using 11 workers (9/12)
✓ Generating static pages using 11 workers (12/12) in 1087ms
  Finalizing page optimization ...
  Collecting build traces ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/orders
├ ƒ /api/orders/[id]
├ ƒ /api/products
├ ƒ /api/products/[id]
├ ƒ /api/store-config
├ ○ /cart
├ ○ /checkout
├ ƒ /healthz
├ ƒ /order/[id]
├ ○ /orders
├ ƒ /product/[id]
├ ○ /products
└ ƒ /readyz


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

## Desktop and mobile browser checks

```text
PASS desktop: catalog search, reset and empty state
PASS desktop: category filtering and keyboard skip link
PASS desktop: product details, add, quantity and cart removal
PASS desktop: checkout validation, error, retry and real BFF order
PASS desktop: lookup invalid input, retry, result and history
PASS desktop: catalog error and retry
PASS desktop: same-origin API requests and browser key boundary
PASS mobile: catalog search, reset and empty state
PASS mobile: closed drawer excluded from Tab, focus trap, Escape return
PASS mobile: product details, add, quantity and cart removal
PASS mobile: checkout validation, error, retry and real BFF order
PASS mobile: lookup invalid input, retry, result and history
PASS mobile: catalog error and retry
PASS mobile: same-origin API requests and browser key boundary
```

## Additional results

- TypeScript: exit 0.
- Static browser assets: no occurrence of the dummy build-time API-key value.
- Browser checks include image loading, horizontal overflow, configured font, keyboard focus, same-origin fetch/XHR and response/request key checks.
- Required repository acceptance CI also runs format, lint, backend tests, DynamoDB Local and container acceptance. Consult the replacement PR checks for its exact head.
