#!/bin/bash
set -e
GATEWAY=http://localhost:3000
echo "=== 1. Register ==="
curl -s -X POST $GATEWAY/api/v1/auth/register -H "Content-Type: application/json" -d '{"email":"test@shop.com","username":"tester","password":"123456"}' | jq .
echo "=== 2. Login ==="
RESP=$(curl -s -X POST $GATEWAY/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"test@shop.com","password":"123456"}')
echo $RESP | jq .
TOKEN=$(echo $RESP | jq -r .access_token)
UID=$(echo $RESP | jq -r .user.id)
echo "TOKEN=$TOKEN"
echo "=== 3. Products ==="
curl -s $GATEWAY/api/v1/products | jq .pagination
echo "=== 4. Create Order ==="
ORDER=$(curl -s -X POST $GATEWAY/api/v1/orders -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"customer_id":"'"$UID"'","items":[{"product_id":"prod-42","quantity":1}],"shipping_address":{"street":"123 Nguyen Hue","city":"HCM"}}')
echo $ORDER | jq .
ORDER_ID=$(echo $ORDER | jq -r .data.id)
echo "=== 5. Payment REST->SOAP (WSDL) ==="
curl -s -X POST $GATEWAY/api/v1/payments -H "Content-Type: application/json" -d '{"orderId":"'"$ORDER_ID"'","amount":15000000,"currency":"VND","cardNumber":"4111111111111111","expiryDate":"12/28","cvv":"123"}' | jq .
echo "=== 6. Confirm Order ==="
curl -s -X POST $GATEWAY/api/v1/orders/$ORDER_ID/confirm -H "Authorization: Bearer $TOKEN" | jq .
echo "=== 7. Notifications ==="
curl -s $GATEWAY/api/v1/notifications | jq .
echo "=== 8. WSDL ==="
curl -s http://localhost:3004/wsdl?wsdl | head -n 20
echo "=== 9. SOAP Fault demo (4000 card) ==="
curl -s -X POST $GATEWAY/api/v1/payments -H "Content-Type: application/json" -d '{"orderId":"FAIL","amount":1000,"currency":"VND","cardNumber":"4000123412341234","expiryDate":"12/28","cvv":"123"}' | jq .
