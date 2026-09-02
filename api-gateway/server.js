const express=require('express'); const cors=require('cors'); const jwt=require('jsonwebtoken'); const {createProxyMiddleware}=require('http-proxy-middleware');
const swaggerUi=require('swagger-ui-express');
const axios=require('axios');
const CircuitBreaker=require('opossum');
let redisClient=null;
// Dual-mode: Docker (redis://redis:6379 via docker-compose.yml:82) <-> Render (rediss://...upstash.io:6379) <-> local/no-redis (in-memory)
// Chỉ kết nối khi REDIS_URL được set explicit, tránh spam [redis] error khi chạy không có Redis
const REDIS_URL=process.env.REDIS_URL;
if(!REDIS_URL){
  console.log('[gateway] Redis disabled (no REDIS_URL), using in-memory rate limit');
} else {
  try {
    const {createClient} = require('redis');
    redisClient=createClient({url:REDIS_URL});
    redisClient.on('error', e=> console.log('[redis] error',e.message));
    redisClient.connect().then(()=>console.log('[gateway] Redis connected '+REDIS_URL)).catch(e=>{console.log('[gateway] Redis unavailable, fallback to in-memory',e.message); try{redisClient.disconnect();}catch(_){} redisClient=null;});
  } catch(e){ console.log('[gateway] redis module not available, in-memory fallback',e.message); redisClient=null; }
}

const app=express();
app.use(cors()); app.use(express.json());

const PORT=process.env.PORT||3000;
const JWT_SECRET=process.env.JWT_SECRET||'soa_jwt_secret_2026';
const USER_URL=process.env.USER_SERVICE_URL||'http://localhost:3001';
const PRODUCT_URL=process.env.PRODUCT_SERVICE_URL||'http://localhost:3002';
const ORDER_URL=process.env.ORDER_SERVICE_URL||'http://localhost:3003';
const PAYMENT_URL=process.env.PAYMENT_SERVICE_URL||'http://localhost:3005';
const NOTIF_URL=process.env.NOTIF_SERVICE_URL||'http://localhost:3006';
const SOAP_URL=process.env.SOAP_GATEWAY_URL||'http://localhost:3004';

// ---------- Swagger Gateway aggregated (manual) ----------
const swaggerSpec={
  "openapi": "3.0.0",
  "info": {
    "title": "E-Commerce SOA - API Gateway",
    "version": "1.0.0",
    "description": "Gateway 3000 proxy to 5 microservices + SOAP. Test all REST via gateway (JWT, rateLimit 100/min). Hub: /docs links to each service swagger."
  },
  "servers": [
    {
      "url": "https://api-gateway-cxkr.onrender.com",
      "description": "Render (mặc định khi mở trên Render)"
    },
    {
      "url": "http://localhost:3000",
      "description": "Local Docker (chọn khi chạy docker compose up)"
    }
  ],
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      }
    },
    "schemas": {
      "RegisterRequest": {
        "type": "object",
        "required": [
          "email",
          "username",
          "password"
        ],
        "properties": {
          "email": {
            "type": "string",
            "example": "a@shop.com"
          },
          "username": {
            "type": "string",
            "example": "buyer1"
          },
          "password": {
            "type": "string",
            "example": "123456"
          },
          "roles": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "example": [
              "BUYER"
            ]
          }
        }
      },
      "LoginRequest": {
        "type": "object",
        "required": [
          "email",
          "password"
        ],
        "properties": {
          "email": {
            "type": "string",
            "example": "a@shop.com"
          },
          "password": {
            "type": "string",
            "example": "123456"
          }
        }
      },
      "CreateOrder": {
        "type": "object",
        "required": [
          "customer_id",
          "items"
        ],
        "properties": {
          "customer_id": {
            "type": "string",
            "example": "uuid-from-login"
          },
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "product_id": {
                  "type": "string",
                  "example": "prod-42"
                },
                "quantity": {
                  "type": "integer",
                  "example": 1
                }
              }
            }
          },
          "shipping_address": {
            "type": "object",
            "properties": {
              "street": {
                "type": "string"
              },
              "city": {
                "type": "string"
              }
            }
          }
        }
      },
      "PaymentRequest": {
        "type": "object",
        "required": [
          "orderId",
          "amount",
          "cardNumber"
        ],
        "properties": {
          "orderId": {
            "type": "string",
            "example": "ORD-2026-XXXX"
          },
          "amount": {
            "type": "integer",
            "example": 15000000
          },
          "currency": {
            "type": "string",
            "example": "VND"
          },
          "cardNumber": {
            "type": "string",
            "example": "4111111111111111"
          },
          "expiryDate": {
            "type": "string",
            "example": "12/28"
          },
          "cvv": {
            "type": "string",
            "example": "123"
          },
          "idempotencyKey": {
            "type": "string",
            "example": "idem-123"
          }
        }
      }
    }
  },
  "tags": [
    {
      "name": "Auth"
    },
    {
      "name": "Products"
    },
    {
      "name": "Orders"
    },
    {
      "name": "Payments"
    },
    {
      "name": "Notifications"
    },
    {
      "name": "Gateway"
    }
  ],
  "paths": {
    "/health": {
      "get": {
        "summary": "Health gateway",
        "tags": [
          "Gateway"
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/": {
      "get": {
        "summary": "Gateway info",
        "tags": [
          "Gateway"
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/docs": {
      "get": {
        "summary": "Swagger hub links",
        "tags": [
          "Gateway"
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/auth/register": {
      "post": {
        "summary": "Register via gateway -> user-service",
        "tags": [
          "Auth"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/RegisterRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created"
          },
          "409": {
            "description": "Conflict"
          }
        }
      }
    },
    "/api/v1/auth/login": {
      "post": {
        "summary": "Login via gateway -> user-service",
        "tags": [
          "Auth"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/LoginRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "JWT"
          },
          "401": {
            "description": "Unauthorized"
          }
        }
      }
    },
    "/api/v1/auth/refresh": {
      "post": {
        "summary": "Refresh token",
        "tags": [
          "Auth"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "refresh_token": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/products": {
      "get": {
        "summary": "List products",
        "tags": [
          "Products"
        ],
        "parameters": [
          {
            "name": "page",
            "in": "query",
            "schema": {
              "type": "integer",
              "default": 1
            }
          },
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer",
              "default": 10
            }
          },
          {
            "name": "category",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "sort",
            "in": "query",
            "schema": {
              "type": "string",
              "example": "price"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      },
      "post": {
        "summary": "Create product",
        "tags": [
          "Products"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "name",
                  "price"
                ],
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "price": {
                    "type": "integer",
                    "example": 15000000
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created"
          }
        }
      }
    },
    "/api/v1/products/search": {
      "get": {
        "summary": "Search products",
        "tags": [
          "Products"
        ],
        "parameters": [
          {
            "name": "q",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string"
            },
            "example": "ASUS"
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/products/{id}": {
      "get": {
        "summary": "Get product by id",
        "tags": [
          "Products"
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      },
      "put": {
        "summary": "Update product",
        "tags": [
          "Products"
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      },
      "delete": {
        "summary": "Delete product",
        "tags": [
          "Products"
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "204": {
            "description": "No Content"
          }
        }
      }
    },
    "/api/v1/orders": {
      "post": {
        "summary": "Create order (JWT)",
        "tags": [
          "Orders"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateOrder"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created"
          },
          "401": {
            "description": "Unauthorized"
          }
        }
      },
      "get": {
        "summary": "List orders (JWT)",
        "tags": [
          "Orders"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/orders/{id}": {
      "get": {
        "summary": "Get order by id (JWT)",
        "tags": [
          "Orders"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/orders/{id}/confirm": {
      "post": {
        "summary": "Confirm order",
        "tags": [
          "Orders"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/orders/{id}/cancel": {
      "post": {
        "summary": "Cancel order",
        "tags": [
          "Orders"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/orders/{id}/status": {
      "patch": {
        "summary": "Change status",
        "tags": [
          "Orders"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "status": {
                    "type": "string",
                    "enum": [
                      "CONFIRMED",
                      "PROCESSING",
                      "SHIPPED",
                      "DELIVERED",
                      "CANCELLED"
                    ]
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/payments": {
      "post": {
        "summary": "Payment REST -> SOAP",
        "tags": [
          "Payments"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/PaymentRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created"
          },
          "502": {
            "description": "SOAP Fault"
          }
        }
      },
      "get": {
        "summary": "List payments",
        "tags": [
          "Payments"
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/payments/{id}": {
      "get": {
        "summary": "Get payment",
        "tags": [
          "Payments"
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/payments/{id}/refund": {
      "post": {
        "summary": "Refund",
        "tags": [
          "Payments"
        ],
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/notifications": {
      "get": {
        "summary": "List notifications",
        "tags": [
          "Notifications"
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    }
  }
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {explorer:true, customSiteTitle:'SOA Gateway Swagger'}));
app.get('/api-docs.json',(req,res)=>res.json(swaggerSpec));

// Docs hub
app.get('/docs', (req,res)=>res.json({
  message:'Swagger hub — từng service expose riêng',
  gateway:`http://localhost:${PORT}/api-docs`,
  services:{
    user: `${USER_URL}/api-docs`,
    product: `${PRODUCT_URL}/api-docs`,
    order: `${ORDER_URL}/api-docs`,
    payment: `${PAYMENT_URL}/api-docs`,
    notification: `${NOTIF_URL}/api-docs`,
    soap: `${SOAP_URL}/api-docs (WSDL: ${SOAP_URL}/wsdl?wsdl)`
  },
  note:'Khi chạy docker-compose, thay localhost bằng tên service: http://user-service:3001/api-docs ... Gateway vẫn ở http://localhost:3000/api-docs'
}));

// ---------- Redis distributed rate limiting (100 req/min) + fallback ----------
const hits=new Map();
async function rateLimit(req,res,next){
  if(req.path.startsWith('/api-docs') || req.path.startsWith('/docs') || req.path=='/health' || req.path=='/') return next();
  const id=req.headers['authorization']?.slice(0,20)||req.ip;
  const windowSec=60; const limit=100;
  if(redisClient && redisClient.isReady){
    try{
      const key=`rl:${id}`;
      const count=await redisClient.incr(key);
      if(count===1) await redisClient.expire(key, windowSec);
      if(count>limit) return res.status(429).json({status:429, detail:'Rate limit 100 req/min (Redis)', current:count});
      res.setHeader('X-RateLimit-Remaining', limit-count);
      return next();
    } catch(e){ console.log('[rateLimit] redis fail fallback',e.message);}
  }
  // in-memory fallback
  const now=Date.now(); const windowMs=60*1000;
  if(!hits.has(id)) hits.set(id,[]);
  const arr=hits.get(id).filter(t=>now-t<windowMs);
  arr.push(now); hits.set(id,arr);
  if(arr.length>100) return res.status(429).json({status:429,detail:'Rate limit 100 req/min (in-memory)'});
  next();
}
app.use((req,res,next)=>{ console.log(`[gateway] ${req.method} ${req.url}`); next(); });
app.use(rateLimit);

// ---------- Circuit Breaker per downstream ----------
function makeBreaker(name, target){
  const fn = async () => {
    const r = await axios.get(`${target}/health`, {timeout:2000});
    if(r.status>=500) throw new Error('health 5xx');
    return true;
  };
  const breaker = new CircuitBreaker(fn, {timeout:3000, errorThresholdPercentage:50, resetTimeout:10000, volumeThreshold:5});
  breaker.on('open', ()=> console.log(`[breaker] ${name} OPEN - requests will fallback 503`));
  breaker.on('halfOpen', ()=> console.log(`[breaker] ${name} HALF_OPEN - testing`));
  breaker.on('close', ()=> console.log(`[breaker] ${name} CLOSED`));
  return breaker;
}
const breakers={
  user: makeBreaker('user-service', USER_URL),
  product: makeBreaker('product-service', PRODUCT_URL),
  order: makeBreaker('order-service', ORDER_URL),
  payment: makeBreaker('payment-service', PAYMENT_URL),
  notif: makeBreaker('notification-service', NOTIF_URL),
};
// periodic health check
setInterval(()=>{ Object.values(breakers).forEach(b=> b.fire().catch(()=>{})); }, 5000);

function breakerMiddleware(name){
  return async (req,res,next)=>{
    const b=breakers[name];
    if(b && b.opened){
      return res.status(503).json({status:503, title:'Circuit Breaker OPEN', detail:`${name} tạm thời unavailable, thử lại sau`, breaker:name});
    }
    next();
  };
}

function authOptional(req,res,next){ next(); }
function authRequired(req,res,next){
  const h=req.headers.authorization;
  if(!h?.startsWith('Bearer ')) return res.status(401).json({status:401,detail:'Missing Bearer token'});
  try{ req.user=jwt.verify(h.slice(7),JWT_SECRET); next(); }catch(e){ return res.status(401).json({status:401,detail:'Invalid token: '+e.message});}
}

app.get('/health',(req,res)=>res.json({service:'api-gateway',status:'ok',routes:{users:USER_URL,products:PRODUCT_URL,orders:ORDER_URL,payments:PAYMENT_URL,notifications:NOTIF_URL,soap:SOAP_URL}, breakers:Object.fromEntries(Object.entries(breakers).map(([k,v])=>[k, v.stats])), redis: redisClient?.isOpen?'connected':'in-memory'}));
app.get('/',(req,res)=>res.json({message:'E-Commerce SOA API Gateway (Kong/Nginx mock)',version:'v1',gateway_docs:'/api-docs',hub:'/docs',endpoints:['/api/v1/auth/register','/api/v1/auth/login','/api/v1/products','/api/v1/orders','/api/v1/payments']}));

// Proxy helper with breaker error handling
function proxy(target, breakerName, opts={}){
  return createProxyMiddleware({
    target, changeOrigin:true, logLevel:'silent',
    pathRewrite: opts.pathRewrite,
    onProxyReq:(proxyReq,req)=>{ if(req.body && Object.keys(req.body).length){ const body=JSON.stringify(req.body); proxyReq.setHeader('Content-Type','application/json'); proxyReq.setHeader('Content-Length',Buffer.byteLength(body)); proxyReq.write(body);} },
    onError:(err, req, res)=>{
      console.log(`[gateway] proxy error ${breakerName}`,err.message);
      const b=breakers[breakerName];
      // circuit breaker will open after repeated failures via health checks, here just log
      if(!res.headersSent) res.status(502).json({status:502, title:'Bad Gateway', detail:`${breakerName} unavailable: `+err.message, breaker: breakerName});
    }
  });
}

// Routes with breaker + auth
app.use('/api/v1/auth', breakerMiddleware('user'), proxy(USER_URL, 'user'));
app.use('/api/v1/products', breakerMiddleware('product'), proxy(PRODUCT_URL, 'product', {pathRewrite:{'^/api/v1/products':'/api/v1/products'}}));
app.use('/api/v1/orders', (req,res,next)=>authRequired(req,res,next), breakerMiddleware('order'), proxy(ORDER_URL, 'order'));
app.use('/api/v1/payments', breakerMiddleware('payment'), proxy(PAYMENT_URL, 'payment'));
app.use('/api/v1/notifications', breakerMiddleware('notif'), proxy(NOTIF_URL, 'notif'));

app.listen(PORT,()=>console.log(`[api-gateway] http://localhost:${PORT} → routes ready — Swagger http://localhost:${PORT}/api-docs — Hub http://localhost:${PORT}/docs — Redis ${redisClient?'enabled':'fallback'} — Breakers ready`));
