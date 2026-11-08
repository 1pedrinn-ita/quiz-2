# Frontend recovery and integration notes

The current published directory contains `assets/index-PLGzEtP5.js`, CSS, and the campaign icon, but the entry bundle references 25 absent JavaScript chunks. They were not found in the checked project copies, related local backups, or available Git history. Do not recreate them from route names or compiled output fragments; recover the matching build artifacts or source revision first.

## Missing chunks

| Area indicated by the entry bundle | Missing files |
| --- | --- |
| Router/bootstrap and shared runtime | `routes-B5DyioSp.js`, `useRouter-Dpb7RwMI.js`, `useNavigate-DT7ghfdY.js`, `link-BH4TZkOC.js`, `preload-helper-BmLnFoW3.js`, `createServerFn-BvYVUQWk.js` |
| Checkout and PIX UI | `checkout-BzjqSENo.js`, `pix-payment-D_PUXjtA.js`, `loader-circle-Dn9zey0a.js`, `check-2l-9cgAv.js`, `arrow-left-ChghSQK_.js` |
| Order confirmation and post-sale | `pedido-CpvpOrWR.js`, `parabens-BIq5vw2a.js`, `package-check-vDcTL3gR.js` |
| Order tracking | `acompanhar-BvfEuwuA.js`, `order-tracking-access-D3gIW6WC.js`, `tracking-access-DRltV0yt.js`, `tracking-BmYU30qX.js` |
| Store, quiz, and shared campaign routes | `loja-DMRDGVg2.js`, `quiz-DuLlNCgV.js`, `campaign-DrCUSxaj.js`, `campaign-frame-C4KkkZVY.js`, `campaign-countdown-DNvVEQ2b.js`, `campaign-modal-TI3r6sgC.js`, `createLucideIcon-DyOSRp63.js` |

The grouping reflects dynamic imports in the available entry bundle. Confirm each recovered module against the matching source/build before editing its click or submit handlers. Missing shared imports can prevent hydration across routes, so isolated HTML edits cannot currently establish that the page is clickable.

## API connection sequence

1. The recovered checkout sends SKU, quantity, customer data, and required delivery address to `POST /api/create-order`. It generates one unpredictable `Idempotency-Key` per attempted order and reuses it for retries. It must not send an authoritative price or payment status.
2. Keep the returned `orderId` and `checkoutToken` out of URLs, analytics, and logs. Send them to `POST /api/create-pix` to request the PIX code.
3. Display only the QR code and copy-and-paste value returned by the server. If creation is uncertain, show the server's reconciliation state; never retry by creating another order/payment with a new key automatically.
4. Poll `GET /api/orders?orderId={uuid}` using `Authorization: Bearer {checkoutToken}`. The server's order/payment status is the authority for pending, approved, failed, refunded, or chargeback states. Browser query parameters and callback payloads do not prove payment.
5. The `/pedido` page should use the authenticated order lookup and display only stored shipment/tracking values. A separate public tracking form may submit a carrier code to `POST /api/track-order`; it returns logistics fields only for a uniquely matching paid order and does not return customer data. The code functions as a lookup secret. `POST /api/update-order-tracking` is an operator endpoint; its operations token must never enter the browser bundle.

6. There is no carrier integration or automatic synchronization in this repository. The protected operator endpoint is the current source of shipment status, carrier, URL, and tracking history; do not present estimated or simulated carrier events as live updates.

## Clickability and verification

After restoring the matching build, verify route chunk requests succeed, hydration completes, and every existing button/link has its intended handler. Add browser tests for product selection, checkout submit, PIX retry, polling, post-sale navigation, and tracking lookup using mocked APIs. Do not change visual structure to compensate for missing chunks. Keep payment tests on mocks or an authorized sandbox; do not publish or connect the flow to a commercial page until brand authorization is confirmed.
