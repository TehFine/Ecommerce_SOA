# E-Commerce SOA Platform — Tuần 03 | Node.js

Mô phỏng **5 microservices độc lập** theo case study slide 39-49.

## Kiến trúc (slide 42)
```
[Web/Mobile/Third-party] → API Gateway (3000) →  [User 3001 | Product 3002 | Order 3003 | Payment 3005 | Notification 3006]
                                                    |         |            |         | SOAP → [Payment SOAP Gateway 3004 (WSDL)]
                                                    MySQL*    ES*          PG*       RabbitMQ 5672 → Notification (event-driven)
* demo dùng in-memory, thay bằng DB thật khi deploy production
```

| Service | Protocol | Port | DB mô phỏng | Đặc tả |
|---------|----------|------|-------------|--------|
| User Service | REST + JWT | 3001 | MySQL (in-mem) + Redis mock | OpenAPI `/api-docs` |
| Product Service | REST | 3002 | Elasticsearch (in-mem) | OpenAPI |
| Order Service | REST + Event | 3003 | PostgreSQL (in-mem) | StateMachine + RabbitMQ `OrderCreated` |
| Payment SOAP Gateway | SOAP/WSDL | 3004 | — | WSDL `?wsdl` , WS-Security UsernameToken |
| Payment Service | REST → SOAP | 3005 | transaction log | gọi SOAP gateway |
| Notification Service | Event-driven REST | 3006 | — | subscribe 5 events |

## Deploy riêng biệt? (phân tích đề)
**Kết luận: CÓ — theo slide 49**: `5 microservices độc lập, deploy riêng biệt — mỗi service scale theo nhu cầu`. 
- **Production**: mỗi service là 1 Deployment riêng trên K8s, scale horizontal khác nhau (User/Product cần scale nhiều, Payment cần HA + PCI-DSS).
- **Bài tập lab**: dùng `docker-compose up` — mỗi service là 1 container riêng, giao tiếp qua `soa-net` → vẫn đảm bảo *loosely coupled, independent deploy* nhưng chạy trên 1 máy. Không nên gộp thành monolith vì sẽ vi phạm SLA 99.9% (cascade failure) và mất tính reusable/interoperable của SOA.

## Chạy nhanh (không Docker)
```bash
# terminal 1..7
cd user-service && npm install && npm start
cd product-service && npm install && npm start
cd payment-soap-gateway && npm install && npm start
cd payment-service && npm install && npm start
cd notification-service && npm install && npm start
cd order-service && npm install && npm start
cd api-gateway && npm install && npm start
```

## Chạy với Docker (khuyến nghị)
```bash
docker compose up --build
# gateway: http://localhost:3000
# RabbitMQ UI: http://localhost:15672 (guest/guest)
```

## Test mẫu
```bash
# 1. Register + login (JWT)
curl -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{"email":"a@shop.com","username":"buyer1","password":"123456"}'
curl -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"a@shop.com","password":"123456"}'

# 2. Products
curl http://localhost:3000/api/v1/products
curl "http://localhost:3000/api/v1/products/search?q=ASUS"

# 3. Create Order (cần JWT)
curl -X POST http://localhost:3000/api/v1/orders -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{"items":[{"product_id":"prod-42","quantity":1}]}'

# 4. Payment REST -> SOAP
curl -X POST http://localhost:3000/api/v1/payments -H "Content-Type: application/json" -d '{"orderId":"ORD-2026-00101","amount":15900000,"currency":"VND","cardNumber":"4111111111111111","expiryDate":"12/28","cvv":"123"}'

# 5. SOAP trực tiếp (test WSDL)
curl http://localhost:3004/wsdl?wsdl
# SoapUI: import WSDL, gọi processPayment với WS-Security header MERCHANT_001
```
