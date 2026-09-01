# PHÂN TÍCH CHI TIẾT CASE STUDY — E-Commerce SOA (Tuần 03)

## 1. Yêu cầu đề bài (slide 39-49)
**Bài toán:** Startup cần nền tảng thương mại điện tử đa kênh (Web React + Mobile Flutter + Third-party seller) có khả năng mở rộng, tái sử dụng component.

**5 chức năng nghiệp vụ chính (slide 40):**
- Quản lý người dùng, Danh mục sản phẩm, Quản lý đơn hàng, Thanh toán (SOAP), Thông báo (Event)

### Yêu cầu chức năng (Functional)
- **User Service:** register/login, JWT auth, profile, RBAC (BUYER/SELLER/ADMIN) — slide 43
- **Product Service:** CRUD, full-text search, tồn kho real-time, filter/sort/pagination — slide 44
- **Order Service:** tạo đơn, state machine `PENDING→CONFIRMED→PROCESSING→SHIPPED→DELIVERED` + `*→CANCELLED`, tính tổng, reserve stock, publish event — slide 45
- **Payment Service:** REST nội bộ → gọi **Payment Gateway SOAP** (VNPay/Momo) với WS-Security, xử lý callback, refund, lưu transaction — slide 46
- **Notification Service:** lắng nghe 5 loại event từ RabbitMQ → gửi Email (SendGrid), SMS (Twilio), Push (FCM) — slide 47

### Yêu cầu phi chức năng (Non-Functional — slide 41)
- Scalability: 10,000 concurrent users, scale horizontal
- Availability: 99.9% uptime — mỗi service độc lập, không cascade failure → cần **Circuit Breaker** (slide 49)
- Performance: API <500ms (p99), search <200ms → slide 48-49 đạt 120ms/380ms
- Security: HTTPS, JWT, PCI-DSS cho payment, WS-Security, bcrypt cost 12
- Maintainability: CI/CD, containerized Docker/K8s

## 2. Kiến trúc SOA tổng thể (slide 42)
```
[Client: Web|Mobile|Seller] → API Gateway (Kong/Nginx) 
  → User 3001 (MySQL+Redis) REST
  → Product 3002 (Elasticsearch+S3) REST
  → Order 3003 (PostgreSQL+RabbitMQ) REST+Event
  → Payment 3005 (REST) —SOAP→ Payment Gateway 3004 (WSDL+WS-Security)
  → Notification 3006 (RabbitMQ consumer) REST→SendGrid/Twilio/FCM
```
**3 vai trò SOA (slide 6):** Provider (5 services), Registry (UDDI/internal catalog), Consumer (Web/Mobile + các service gọi nhau).
**Vòng đời (slide 8):** Model → Assemble → Deploy → Manage → Govern.

## 3. Phân loại Service (Entity/Task/Utility — slide 9)
- **Entity Service:** User Service, Product Service (CRUD thực thể bền vững)
- **Task Service:** Order Service (quy trình nghiệp vụ có state machine)
- **Utility Service:** Notification Service (tái sử dụng chéo, event-driven)

## 4. REST vs SOAP — Tại sao Payment dùng SOAP? (slide 37-38)
| Tiêu chí | 4 services REST | Payment SOAP |
|---|---|---|
| Contract | OpenAPI linh hoạt, JSON nhẹ | WSDL nghiêm ngặt, tự sinh code |
| Security | JWT/OAuth2 tự implement | WS-Security message-level encryption + signing (bắt buộc với tiền) |
| Transaction | không built-in | WS-AtomicTransaction |
| Phù hợp | Public API, Mobile, Microservices | Enterprise B2B, Banking, Hóa đơn điện tử, VNPay gateway |
→ **Kết luận:** Payment Gateway của đối tác đã expose SOAP, ta phải tích hợp SOAP và bọc lại thành REST nội bộ cho các service khác gọi.

## 5. CÓ CẦN DEPLOY TỪNG SERVICE RIÊNG HAY KHÔNG? — Phân tích quyết định cốt lõi

### 5.1 Slide nói gì?
Slide 49 **"Kết quả triển khai"**: `5 microservices độc lập, deploy riêng biệt — mỗi service scale theo nhu cầu` + `REST: 24 endpoints + SOAP + Event-driven`.

### 5.2 Nếu GỘP chung (Monolith) sẽ vi phạm gì?
- Mất **Loosely Coupled** (slide 5): 1 lỗi Payment làm sập cả User/Product → vi phạm Availability 99.9% và Circuit Breaker (slide 49).
- Không scale riêng: Product search cần nhiều CPU/RAM hơn User → monolith buộc scale cả khối → lãng phí.
- Mất Reusability: Seller third-party cần gọi riêng Product API → monolith khó expose riêng.
- Vi phạm SLA: không đo được response P99 riêng từng service.

### 5.3 Nếu TÁCH riêng (Microservices — khuyến nghị) được gì?
- **Independent Deploy & Scale:** `docker-compose.yml` mỗi service 1 container, K8s mỗi service 1 Deployment + HPA riêng.
- **Fault Isolation:** Payment SOAP timeout không cascade → Gateway trả 502, User/Product vẫn sống.
- **Technology Heterogeneity:** Product dùng Elasticsearch, User dùng MySQL, Order dùng PostgreSQL như slide 42.
- **Governance:** mỗi service có WSDL/OpenAPI + version `/api/v1` riêng (slide 48-49).

### 5.4 3 mức triển khai cho bài tập (từ nhẹ → nặng)
| Mức | Mô tả | Khi nào dùng | Đáp ứng SOA? |
|---|---|---|---|
| **A. Single-process mock** | 1 repo Node, 5 router Express khác prefix | Demo logic nhanh, máy yếu | 30% — chỉ mô phỏng, không chứng minh deploy riêng |
| **B. Multi-process + Different ports (đã làm)** | 7 process Node riêng: 3001-3006 + Gateway 3000, giao tiếp HTTP/RabbitMQ qua `localhost` | Lab trên laptop, không cần Docker, vẫn chứng minh *deploy riêng* | 90% — đủ cho điểm HDV, giảng viên `ps aux | grep node` thấy 6 service riêng |
| **C. Docker Compose (khuyến nghị nộp)** | Mỗi service 1 Dockerfile + `docker-compose up --build` + RabbitMQ container, network `soa-net` | Nộp bài chuyên nghiệp, đúng slide 49 + CI/CD | 100% — `docker ps` thấy 7 containers riêng, scale `docker compose up --scale product-service=3` |
| **D. K8s (production)** | Helm chart, mỗi service Deployment + Service + Ingress | Công ty thật | 100% |

**→ Khuyến nghị cho bạn (quen Node.js): Chọn B để dev nhanh, sau đó `docker compose up` để demo nộp. Đã dựng sẵn cả B và C trong repo này.**

### 5.5 Trade-off khi tách riêng
- **Cons:** thêm network latency, phải xử lý distributed transaction (idempotency key cho Payment slide 49), tracing (Jaeger), config phức tạp hơn.
- **Giải pháp đã implement:** IdempotencyKey trong `POST /payments`, fallback HTTP khi RabbitMQ chưa chạy, JWT verify tại Gateway, WSDL strict.

## 6. Đặc tả Interface (Contract-first — slide 10-11)
- **WSDL** (`payment-soap-gateway/payment.wsdl`): 3 operations `processPayment, checkPaymentStatus, refundPayment`, types XSD, binding Document/Literal, service endpoint `http://localhost:3004/wsdl`.
- **OpenAPI** (mỗi service `/api-docs`): ví dụ User 7 endpoints, Product 6 endpoints, Order 6 endpoints, Payment 3 endpoints → tổng 24 REST endpoints như slide 49.

## 7. Luồng nghiệp vụ mẫu (slide 45 integration)
1. Client `POST /auth/register` → User Service tạo user bcrypt, trả JWT
2. `GET /products?category=laptop` → Product Service query Elasticsearch mock
3. `POST /orders {customer_id, items}` → Order Service gọi `GET /internal/validate` + `POST /internal/reserve` → tính total → tạo ORD → publish `OrderCreated` → RabbitMQ
4. Notification consumer nhận `OrderCreated` → gửi Email
5. `POST /payments {orderId, card}` → Payment Service tạo WS-Security header → gọi SOAP `processPayment` → nhận `TXN-... SUCCESS`
6. Order `POST /orders/:id/confirm` → publish `OrderConfirmed` → Notification gửi SMS receipt

## 8. Kiểm thử (slide 48)
- Unit: JUnit/Pytest mock external calls — đã mock Product/User khi test Order.
- Integration: Postman collection + SoapUI cho WSDL.
- Performance: JMeter 1000 concurrent, p99 <500ms.
- Security: JWT validation, WS-Security, bcrypt.

## 9. Kết luận triển khai Node.js
- Stack thuần Node + Express đáp ứng đủ yêu cầu đồ án, quen thuộc, dễ deploy (Docker/K8s).
- Đã cung cấp **đầy đủ 5 services độc lập + 1 SOAP gateway + 1 API Gateway + RabbitMQ**, đúng kiến trúc slide 42, có thể chạy riêng hoặc `docker compose up` → chứng minh **CÓ deploy riêng**.
