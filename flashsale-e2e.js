import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    scenarios: {
        flash_sale: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '20s', target: 250 },
                { duration: '40s', target: 250 },
                { duration: '10s', target: 0 },
            ],
        },
    },
    thresholds: {
        http_req_failed: ['rate<0.01'],
        'checks{type:e2e}': ['rate>0.9'],
    },
    insecureSkipTLSVerify: true,
};

// services
const AUTH_BASE = 'https://localhost/user';
const INV_BASE = 'https://localhost/inventory';
const RES_BASE = 'https://localhost/reservation';
const ORDER_BASE = 'https://localhost/order';
const PAY_BASE = 'https://localhost/payment';

// fixed user (same as swagger)
const TEST_USER_ID = '019A6F21-6597-7207-9482-1C79BBD94198';

export default function () {

    const loginRes = http.post(
        `${AUTH_BASE}/api/Auth/login`,
        JSON.stringify({
            "userName": "duaa",
            "password": "duaa123",
            "name": "test1",
            "email": "test@gmail.com"
        }),
        { headers: { 'Content-Type': 'application/json' } }
    );

    check(loginRes, { 'login 200': r => r.status === 200 });

    const token = loginRes.json('accessToken');
    // const authHeaders = {
    //     'Content-Type': 'application/json',
    //     Authorization: Bearer`${token}`,
    // };


    const cartRes = http.post(
        `${INV_BASE}/api/v1/carts`,
        JSON.stringify({ "userId": TEST_USER_ID }),
        { headers: { 'Content-Type': 'application/json' } }
    );

    check(cartRes, { 'cart created': r => r.status === 200 });

    const cartId = cartRes.json('cartId');

    //
    // 3) GET PRODUCTS
    //
    const productsRes = http.get(
        `${INV_BASE}/api/v1/products?page=1&pageSize=10`,
    );
    check(productsRes, { 'products fetched': r => r.status === 200 });

    const products = productsRes.json();
    const itemId = products && products.length > 0 ? products[0].productId : null;

    // console.log({itemId})

    //
    // 4) ADD ITEM TO CART
    //
    if (itemId) {
        const addRes = http.post(
            `${INV_BASE}/api/v1/carts/${cartId}/items/${itemId}`,
            JSON.stringify({ quantity: 1 }),
            { headers: { 'Content-Type': 'application/json' } }
        );
        check(addRes, { 'item added': r => r.status === 200 });
    }

    //
    // 5) CREATE RESERVATION FROM CART
    //
    const resvPayload = {
        userId: TEST_USER_ID,
        cartId: cartId,
        ttlSeconds: 500,
        idempotencyKey: `k6 - ${__VU}-${__ITER}`,
        correlationId: `k6 - corr - ${__VU} -${__ITER}`,
    };

    const resvRes = http.post(
        `${RES_BASE}/api/v1/ReservationsV1/from-cart`, // sync: V1, async: v2
        JSON.stringify(resvPayload),
        { headers: { 'Content-Type': 'application/json' } }
    );

    check(resvRes, { 'reservation 200': r => r.status === 200 });

    // console.log({resvRes})

    const resvs = resvRes.json();

    // console.log({resvs})
    const reservationId =
        Array.isArray(resvs) && resvs.length > 0 ? resvs[0].id : null;

    // console.log({reservationId})

    //
    // 6) GET ORDER BY RESERVATION (small helper endpoint in Order service)
    //
    let orderObj = null;
    if (reservationId) {
        const maxPollsForOrder = 8; // wait up to ~8s for order service to create it
        for (let i = 0; i < maxPollsForOrder && !orderObj; i++) {
            const oRes = http.get(
                `${ORDER_BASE}/api/v1/Orders/by-reservation/${reservationId}`, // no change
            );

            if (oRes.status === 200) {
                const body = oRes.json();
                orderObj = Array.isArray(body) ? body[0] : body;
                // console.log({orderObj})
            } else {
                sleep(1);
            }
        }
    }

    let e2eDone = false;
    if (orderObj) {
        const orderId = orderObj.id;
        const amount = orderObj.total;

        //
        // 7) PAY FOR ORDER → payment service
        //
        const payPayload = {
            orderId: orderId,
            userId: TEST_USER_ID,
            amount: amount,
            paymentMethod: 'card',
            // correlationId: `k6-pay-${__VU}-${__ITER}`,
        };

        const payRes = http.post(
            `${PAY_BASE}/api/v1/Payments`, // sync: v1, async: v2
            JSON.stringify(payPayload),
            { headers: { 'Content-Type': 'application/json' } }
        );

        // console.log({payRes})

        check(payRes, { 'payment 201': r => r.status === 201 });

        //
        // 8) POLL ORDER UNTIL ORDER SERVICE CONSUMES payment.succeeded
        //
        const maxPollsForPaid = 10;
        for (let i = 0; i < maxPollsForPaid && !e2eDone; i++) {
            const finalOrderRes = http.get(
                `${ORDER_BASE}/api/v1/Orders/${orderId}`
            );

            // console.log({finalOrderRes})

            if (finalOrderRes.status === 200) {
                const status = finalOrderRes.json('orderStatus');
                if (
                    status === 'Paid' ||
                    status === 'PAID' ||
                    status === 'Completed'
                ) {
                    e2eDone = true;
                    break;
                }
            }

            sleep(1);
        }
    }

    check({ e2eDone }, {
        'e2e order completed{type:e2e}': v => v.e2eDone === true,
    });

    sleep(1);
}