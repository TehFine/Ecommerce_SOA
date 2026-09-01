const express=require('express'); const cors=require('cors'); const {v4:uuid}=require('uuid'); const axios=require('axios');
const CircuitBreaker=require('opossum');
const swaggerUi=require('swagger-ui-express');
const app=express(); app.use(cors()); app.use(express.json());
const PORT=process.env.PORT||3003;
const RABBITMQ_URL=process.env.RABBITMQ_URL||'amqp://localhost:5672';
const USER_SERVICE_URL=process.env.USER_SERVICE_URL||'http://localhost:3001';
const PRODUCT_SERVICE_URL=process.env.PRODUCT_SERVICE_URL||'http://localhost:3002';

let orders=[];
let useSupabase=false; let supabase=null;
if(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)){
  try{ const {createClient}=require('@supabase/supabase-js'); supabase=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY); useSupabase=true; console.log('[order-service] Supabase ON'); }catch(e){ console.log('[order-service] Supabase fail',e.message); }
} else console.log('[order-service] Memory mode');

async function dbCreate(order){
  if(!useSupabase){ orders.push(order); return order; }
  // map camelCase to snake_case for Supabase
  const row={id:order.id, user_id:order.userId, items:order.items, shipping_address:order.shipping_address, total:order.total, status:order.status, created_at:order.created_at, updated_at:order.updated_at};
  const {data,error}=await supabase.from('orders').insert(row).select().single();
  if(error) throw new Error(error.message);
  // map back
  return {...data, userId:data.user_id, shipping_address:data.shipping_address};
}
async function dbList(){ if(!useSupabase) return orders; const {data}=await supabase.from('orders').select('*'); return (data||[]).map(r=>({...r, userId:r.user_id, shipping_address:r.shipping_address})); }
async function dbFind(id){ if(!useSupabase) return orders.find(x=>x.id===id); const {data}=await supabase.from('orders').select('*').eq('id',id).maybeSingle(); if(!data) return null; return {...data, userId:data.user_id, shipping_address:data.shipping_address}; }
async function dbUpdate(id,patch){
  if(!useSupabase){ const o=orders.find(x=>x.id===id); if(o) Object.assign(o,patch); return o; }
  const row={}; if(patch.status) row.status=patch.status; if(patch.updated_at) row.updated_at=patch.updated_at; if(patch.userId) row.user_id=patch.userId;
  const {data,error}=await supabase.from('orders').update(row).eq('id',id).select().single();
  if(error) throw new Error(error.message);
  return {...data, userId:data.user_id, shipping_address:data.shipping_address};
}

const STATES={PENDING:'PENDING',CONFIRMED:'CONFIRMED',PROCESSING:'PROCESSING',SHIPPED:'SHIPPED',DELIVERED:'DELIVERED',CANCELLED:'CANCELLED'};
const TRANSITIONS={PENDING:['CONFIRMED','CANCELLED'],CONFIRMED:['PROCESSING','CANCELLED'],PROCESSING:['SHIPPED','CANCELLED'],SHIPPED:['DELIVERED'],DELIVERED:[],CANCELLED:[]};
let channel=null;
// ---------- Circuit Breaker for downstream calls (slide 49: tránh cascade) ----------
const userBreaker = new CircuitBreaker(async (uid)=> {
  const r=await axios.get(`${USER_SERVICE_URL}/api/v1/internal/validate/${uid}`, {timeout:2000});
  return r.data;
}, {timeout:3000, errorThresholdPercentage:50, resetTimeout:10000, volumeThreshold:5});
userBreaker.fallback(()=> ({exists:true, active:true, fallback:true, breaker:'user-service OPEN'}));
userBreaker.on('open', ()=> console.log('[order breaker] user-service OPEN'));
userBreaker.on('close', ()=> console.log('[order breaker] user-service CLOSED'));

const productCheckBreaker = new CircuitBreaker(async (items)=> {
  const r=await axios.post(`${PRODUCT_SERVICE_URL}/api/v1/internal/check`,{items},{timeout:2000});
  return r.data;
}, {timeout:3000, errorThresholdPercentage:50, resetTimeout:10000});
productCheckBreaker.fallback(()=> { throw new Error('product-service unavailable (breaker OPEN)'); });

const productReserveBreaker = new CircuitBreaker(async (product_id, quantity)=> {
  const r=await axios.post(`${PRODUCT_SERVICE_URL}/api/v1/internal/reserve`,{product_id,quantity},{timeout:2000});
  return r.data;
}, {timeout:3000, errorThresholdPercentage:50, resetTimeout:10000});
productReserveBreaker.fallback(()=> { throw new Error('product reserve unavailable (breaker OPEN)'); });

async function initRabbit(){
  try{
    const amqp=require('amqplib');
    const conn=await amqp.connect(RABBITMQ_URL);
    channel=await conn.createChannel();
    await channel.assertExchange('ecommerce','topic',{durable:true});
    console.log('[order-service] RabbitMQ connected');
  }catch(e){ console.log('[order-service] RabbitMQ unavailable, fallback to http notify:',e.message); channel=null;}
}
function publish(event, data){
  if(channel){
    channel.publish('ecommerce',event,Buffer.from(JSON.stringify(data)),{persistent:true});
    console.log(`[order-service] published ${event}`,data.id||data.orderId);
  } else {
    const NOTIF_URL=process.env.NOTIF_URL||'http://localhost:3006';
    axios.post(`${NOTIF_URL}/api/v1/events`,{event,data}).catch(()=>{});
  }
}

const swaggerSpec={
  "openapi": "3.0.0",
  "info": {
    "title": "Order Service API",
    "version": "1.0.0",
    "description": "Task Service - StateMachine + RabbitMQ OrderCreated + User/Product internal"
  },
  "servers": [
    {
      "url": "http://localhost:3003"
    }
  ],
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      }
    }
  },
  "paths": {
    "/health": {
      "get": {
        "summary": "Health",
        "tags": [
          "Health"
        ],
        "responses": {
          "200": {
            "description": "OK"
          }
        }
      }
    },
    "/api/v1/orders": {
      "post": {
        "summary": "Create order - validate user, check & reserve stock, publish OrderCreated",
        "tags": [
          "Orders"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "customer_id",
                  "items"
                ],
                "properties": {
                  "customer_id": {
                    "type": "string",
                    "example": "uuid-user"
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
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created"
          },
          "422": {
            "description": "Insufficient stock"
          }
        }
      },
      "get": {
        "summary": "List orders",
        "tags": [
          "Orders"
        ],
        "parameters": [
          {
            "name": "userId",
            "in": "query",
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
    "/api/v1/orders/{id}": {
      "get": {
        "summary": "Get order",
        "tags": [
          "Orders"
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
          },
          "404": {
            "description": "Not Found"
          }
        }
      }
    },
    "/api/v1/orders/{id}/confirm": {
      "post": {
        "summary": "Confirm PENDING->CONFIRMED",
        "tags": [
          "Orders"
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
          },
          "409": {
            "description": "Conflict"
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
    "/api/v1/orders/{id}/payment-success": {
      "post": {
        "summary": "Callback payment success",
        "tags": [
          "Orders"
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
    }
  }
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec,{explorer:true}));
app.get('/api-docs.json',(req,res)=>res.json(swaggerSpec));

app.get('/health',async (req,res)=>{ const list=await dbList(); res.json({service:'order-service',status:'ok',mode:useSupabase?'supabase':'memory',orders:list.length}); });
app.post('/api/v1/orders', async (req,res)=>{
  const {customer_id,userId,items,shipping_address}=req.body;
  const uid = customer_id||userId;
  if(!uid||!items||!items.length) return res.status(400).json({status:400,detail:'customer_id/userId and items required (min 1)'});
  try{
    const data=await userBreaker.fire(uid);
    if(!data.exists) return res.status(404).json({status:404,detail:'user not found'});
    if(!data.active) return res.status(403).json({status:403,detail:'user not active'});
    if(data.fallback) console.log('[order] user validate fallback (breaker)');
  }catch(e){ console.log('validate user error',e.message); if(e.message.includes('breaker OPEN')) return res.status(503).json({status:503, detail:'user-service temporarily unavailable (circuit breaker)'}); }
  try{
    const check=await productCheckBreaker.fire(items);
    const insufficient=check.results.find(r=>!r.sufficient);
    if(insufficient) return res.status(422).json({status:422,detail:`insufficient stock for ${insufficient.product_id}`,stock:insufficient.stock});
    for(const it of items){
      await productReserveBreaker.fire(it.product_id, it.quantity);
    }
  }catch(e){ 
    if(e.message.includes('breaker OPEN')) return res.status(503).json({status:503, detail:'product-service temporarily unavailable (circuit breaker)'});
    return res.status(422).json({status:422,detail:'inventory error: '+(e.response?.data?.detail||e.message)}); 
  }
  let total=0;
  try{
    const check=await productCheckBreaker.fire(items);
    total=check.results.reduce((s,r)=>{
      const qty=items.find(i=>i.product_id===r.product_id).quantity;
      return s+ r.price*qty;
    },0);
  }catch(e){ console.log('[order] total calc fallback',e.message); }
  const order={id:'ORD-2026-'+uuid().slice(0,8).toUpperCase(),userId:uid,items,shipping_address:shipping_address||null,total,status:STATES.PENDING,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  await dbCreate(order);
  publish('OrderCreated', order);
  res.status(201).json({data:order});
});
app.get('/api/v1/orders',async (req,res)=>{
  const {userId}=req.query;
  let data=await dbList();
  if(userId) data=data.filter(o=>o.userId===userId || o.user_id===userId);
  res.json({data,total:data.length});
});
app.get('/api/v1/orders/:id',async (req,res)=>{
  const o=await dbFind(req.params.id);
  if(!o) return res.status(404).json({status:404,detail:'order not found'});
  res.json({data:o});
});
function canTransition(from,to){ return (TRANSITIONS[from]||[]).includes(to); }
app.post('/api/v1/orders/:id/confirm',async (req,res)=>{
  const o=await dbFind(req.params.id);
  if(!o) return res.status(404).json({status:404,detail:'not found'});
  if(!canTransition(o.status,STATES.CONFIRMED)) return res.status(409).json({status:409,detail:`cannot ${o.status} -> CONFIRMED`});
  const updated=await dbUpdate(o.id, {status:STATES.CONFIRMED, updated_at:new Date().toISOString()});
  publish('OrderConfirmed',updated||o); res.json({data:updated||o});
});
app.post('/api/v1/orders/:id/cancel',async (req,res)=>{
  const o=await dbFind(req.params.id);
  if(!o) return res.status(404).json({status:404,detail:'not found'});
  if(o.status===STATES.SHIPPED||o.status===STATES.DELIVERED) return res.status(409).json({status:409,detail:'cannot cancel after shipped'});
  if(!canTransition(o.status,STATES.CANCELLED)) return res.status(409).json({status:409,detail:`cannot ${o.status} -> CANCELLED`});
  const updated=await dbUpdate(o.id, {status:STATES.CANCELLED}); publish('OrderCancelled',updated||o); res.json({data:updated||o});
});
app.patch('/api/v1/orders/:id/status',async (req,res)=>{
  const o=await dbFind(req.params.id);
  if(!o) return res.status(404).json({status:404,detail:'not found'});
  const {status}=req.body;
  if(!STATES[status]) return res.status(400).json({status:400,detail:'invalid status'});
  if(!canTransition(o.status,status)) return res.status(409).json({status:409,detail:`cannot ${o.status} -> ${status}`});
  const updated=await dbUpdate(o.id, {status, updated_at:new Date().toISOString()});
  if(status===STATES.SHIPPED) publish('OrderShipped',updated||o);
  if(status===STATES.DELIVERED) publish('OrderDelivered',updated||o);
  res.json({data:updated||o});
});
app.post('/api/v1/orders/:id/payment-success',async (req,res)=>{
  const o=await dbFind(req.params.id);
  if(!o) return res.status(404).json({status:404,detail:'not found'});
  const updated=await dbUpdate(o.id, {status:STATES.CONFIRMED}); publish('PaymentSuccess',updated||o); publish('OrderConfirmed',updated||o); res.json({data:updated||o});
});

initRabbit().then(()=> app.listen(PORT,()=>console.log(`[order-service] REST http://localhost:${PORT} - Swagger http://localhost:${PORT}/api-docs`)));
