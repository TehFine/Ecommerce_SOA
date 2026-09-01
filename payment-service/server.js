const express=require('express'); const cors=require('cors'); const soap=require('soap'); const {v4:uuid}=require('uuid');
const CircuitBreaker=require('opossum');
const swaggerUi=require('swagger-ui-express'); const swaggerJSDoc=require('swagger-jsdoc');
const app=express(); app.use(cors()); app.use(express.json());
const PORT=process.env.PORT||3005;
const WSDL_URL=process.env.SOAP_WSDL_URL||'http://localhost:3004/wsdl?wsdl';

const payments=[]; // fallback memory
let useSupabase=false; let supabase=null;
if(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)){
  try{ const {createClient}=require('@supabase/supabase-js'); supabase=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY); useSupabase=true; console.log('[payment-service] Supabase ON'); }catch(e){ console.log('[payment-service] Supabase fail',e.message); }
} else console.log('[payment-service] Memory mode');
async function dbAddPayment(rec){
  if(!useSupabase){ payments.push(rec); return rec; }
  const row={id:rec.id, transaction_id:rec.transactionId, order_id:rec.orderId, amount:rec.amount, currency:rec.currency, status:rec.status, message:rec.message, timestamp:rec.timestamp, created_at:rec.created_at, idempotency_key:rec.idempotencyKey};
  const {data,error}=await supabase.from('payments').insert(row).select().single();
  if(error) throw new Error(error.message);
  return {...rec, transactionId:data.transaction_id, orderId:data.order_id, idempotencyKey:data.idempotency_key};
}
async function dbFindPayment(id){
  if(!useSupabase) return payments.find(x=>x.id===id||x.transactionId===id);
  const {data}=await supabase.from('payments').select('*').or(`id.eq.${id},transaction_id.eq.${id}`).maybeSingle();
  if(!data) return null;
  return {...data, transactionId:data.transaction_id, orderId:data.order_id, idempotencyKey:data.idempotency_key, refundId:data.refund_id};
}
async function dbListPayments(){
  if(!useSupabase) return payments;
  const {data}=await supabase.from('payments').select('*');
  return (data||[]).map(r=>({...r, transactionId:r.transaction_id, orderId:r.order_id, idempotencyKey:r.idempotency_key, refundId:r.refund_id}));
}
async function dbUpdatePayment(id, patch){
  if(!useSupabase){ const p=payments.find(x=>x.id===id||x.transactionId===id); if(p) Object.assign(p,patch); return p; }
  const row={}; if(patch.status) row.status=patch.status; if(patch.refund_id) row.refund_id=patch.refund_id; if(patch.refundId) row.refund_id=patch.refundId;
  const {data,error}=await supabase.from('payments').update(row).or(`id.eq.${id},transaction_id.eq.${id}`).select().single();
  if(error) throw new Error(error.message);
  return {...data, transactionId:data.transaction_id, orderId:data.order_id};
}
// ---------- Circuit Breaker for SOAP Gateway (slide 49) ----------
const soapProcessBreaker = new CircuitBreaker(async ({orderId,amount,currency,cardNumber,expiryDate,cvv,callbackUrl})=>{
  const client=await soap.createClientAsync(WSDL_URL);
  const wsSecurity=new soap.WSSecurity('MERCHANT_001','secret_hashed', {hasTimeStamp:false,hasNonce:true});
  client.setSecurity(wsSecurity);
  const [result]=await client.processPaymentAsync({orderId,amount,currency,cardNumber,expiryDate,cvv,callbackUrl:callbackUrl||'https://api.shop.com/payments/callback'});
  return result;
}, {timeout:5000, errorThresholdPercentage:50, resetTimeout:15000, volumeThreshold:5});
soapProcessBreaker.on('open', ()=> console.log('[payment breaker] SOAP OPEN'));
soapProcessBreaker.on('close', ()=> console.log('[payment breaker] SOAP CLOSED'));
soapProcessBreaker.fallback(()=> { throw new Error('Payment gateway circuit breaker OPEN'); });

const soapRefundBreaker = new CircuitBreaker(async ({transactionId, amount})=>{
  const client=await soap.createClientAsync(WSDL_URL);
  client.setSecurity(new soap.WSSecurity('MERCHANT_001','secret_hashed',{}));
  const [result]=await client.refundPaymentAsync({transactionId,amount});
  return result;
}, {timeout:5000, errorThresholdPercentage:50, resetTimeout:15000});


// ---------- Swagger (manual) ----------
const swaggerSpec={
  openapi:'3.0.0',
  info:{title:'Payment Service API (REST → SOAP)',version:'1.0.0',description:'REST wrapper gọi SOAP Gateway (WSDL + WS-Security) — slide 46. IdempotencyKey support.'},
  servers:[{url:`http://localhost:${PORT}`}],
  paths:{
    '/health':{get:{summary:'Health',tags:['Health'],responses:{'200':{description:'OK'}}}},
    '/api/v1/payments':{
      post:{summary:'Khởi tạo thanh toán REST → gọi SOAP processPayment (WS-Security)',tags:['Payments'],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['orderId','amount','cardNumber'],properties:{orderId:{type:'string',example:'ORD-2026-00101'},amount:{type:'integer',example:15000000},currency:{type:'string',example:'VND'},cardNumber:{type:'string',example:'4111111111111111'},expiryDate:{type:'string',example:'12/28'},cvv:{type:'string',example:'123'},callbackUrl:{type:'string'},idempotencyKey:{type:'string',example:'idem-123'}}}}}},responses:{'201':{description:'Created — transactionId + SUCCESS'},'502':{description:'SOAP Fault — Payment declined'}}},
      get:{summary:'List payments',tags:['Payments'],responses:{'200':{description:'OK'}}}
    },
    '/api/v1/payments/{id}':{get:{summary:'Lấy payment theo id hoặc transactionId',tags:['Payments'],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:{'200':{description:'OK'},'404':{description:'Not Found'}}}},
    '/api/v1/payments/{id}/refund':{post:{summary:'Refund qua SOAP refundPayment',tags:['Payments'],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],requestBody:{content:{'application/json':{schema:{type:'object',properties:{amount:{type:'integer'}}}}}},responses:{'200':{description:'OK'}}}},
    '/api/v1/payments/callback':{post:{summary:'Callback simulation từ SOAP gateway',tags:['Payments'],responses:{'200':{description:'OK'}}}}
  }
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec,{explorer:true}));
app.get('/api-docs.json',(req,res)=>res.json(swaggerSpec));

app.get('/health',async (req,res)=>{ const list=await dbListPayments(); res.json({service:'payment-service',wsdl:WSDL_URL,mode:useSupabase?'supabase':'memory',payments:list.length}); });

/**
 * @swagger
 * /api/v1/payments:
 *   post:
 *     summary: Khởi tạo thanh toán REST → gọi SOAP processPayment (WS-Security)
 *     tags: [Payments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderId, amount, cardNumber]
 *             properties:
 *               orderId: {type: string, example: ORD-2026-00101}
 *               amount: {type: integer, example: 15000000}
 *               currency: {type: string, example: VND}
 *               cardNumber: {type: string, example: "4111111111111111"}
 *               expiryDate: {type: string, example: "12/28"}
 *               cvv: {type: string, example: "123"}
 *               callbackUrl: {type: string}
 *               idempotencyKey: {type: string, example: "idem-123"}
 *     responses:
 *       201: {description: Created — transactionId + SUCCESS}
 *       502: {description: SOAP Fault — Payment declined}
 */
app.post('/api/v1/payments', async (req,res)=>{
  const {orderId,amount,currency='VND',cardNumber,expiryDate,cvv,callbackUrl,idempotencyKey}=req.body;
  if(!orderId||!amount||!cardNumber) return res.status(400).json({status:400,detail:'orderId,amount,cardNumber required'});
  if(idempotencyKey){
    const existing=payments.find(p=>p.idempotencyKey===idempotencyKey);
    if(existing) return res.json({data:existing,message:'idempotent replay'});
  }
  try{
    const result=await soapProcessBreaker.fire({orderId,amount,currency,cardNumber,expiryDate,cvv,callbackUrl});
    const rec={id:uuid(),orderId,amount,currency,transactionId:result.transactionId,status:result.status,message:result.message,timestamp:result.timestamp,created_at:new Date().toISOString(),idempotencyKey:idempotencyKey||null};
    await dbAddPayment(rec);
    res.status(201).json({data:rec});
  }catch(e){
    if(e.message.includes('circuit breaker OPEN')) return res.status(503).json({status:503, title:'Circuit Breaker OPEN', detail:'Payment gateway temporarily unavailable, try again', code:'CIRCUIT_OPEN'});
    const fault=e?.root?.Envelope?.Body?.Fault || e.message;
    console.error('SOAP Fault',JSON.stringify(fault));
    res.status(502).json({status:502,title:'Payment Gateway Error',detail: typeof fault==='string'?fault:JSON.stringify(fault),code:'PAYMENT_FAILED'});
  }
});
/**
 * @swagger
 * /api/v1/payments/{id}:
 *   get:
 *     summary: Lấy payment theo id hoặc transactionId
 *     tags: [Payments]
 *     parameters: [{ name: id, in: path, required:true, schema:{type:string}}]
 *     responses: { 200: {description: OK}, 404: {description: Not Found}}
 */
app.get('/api/v1/payments/:id',async (req,res)=>{
  const p=await dbFindPayment(req.params.id);
  if(!p) return res.status(404).json({status:404,detail:'payment not found'});
  res.json({data:p});
});
/**
 * @swagger
 * /api/v1/payments:
 *   get:
 *     summary: List payments
 *     tags: [Payments]
 *     responses: { 200: {description: OK}}
 */
app.get('/api/v1/payments',async (req,res)=>{ const list=await dbListPayments(); res.json({data:list,total:list.length}); });
/**
 * @swagger
 * /api/v1/payments/{id}/refund:
 *   post:
 *     summary: Refund qua SOAP refundPayment
 *     tags: [Payments]
 *     parameters: [{ name: id, in: path, required:true, schema:{type:string}}]
 *     requestBody: { content: { application/json: { schema: { type: object, properties: {amount:{type:integer}} } } } }
 *     responses: { 200: {description: OK}}
 */
app.post('/api/v1/payments/:id/refund', async (req,res)=>{
  const p=await dbFindPayment(req.params.id);
  if(!p) return res.status(404).json({status:404,detail:'not found'});
  try{
    const result=await soapRefundBreaker.fire({transactionId:p.transactionId, amount:req.body.amount});
    const updated=await dbUpdatePayment(p.id||p.transaction_id||req.params.id, {status:'REFUNDED', refund_id: result.refundId});
    res.json({data:updated||p});
  }catch(e){ 
    if(e.message.includes('circuit breaker OPEN')) return res.status(503).json({status:503, detail:'Payment gateway breaker OPEN'});
    res.status(502).json({status:502,detail:e.message});}
});
// callback simulation
/**
 * @swagger
 * /api/v1/payments/callback:
 *   post:
 *     summary: Callback simulation từ SOAP gateway
 *     tags: [Payments]
 *     responses: { 200: {description: OK}}
 */
app.post('/api/v1/payments/callback',(req,res)=>{
  console.log('[payment-service] callback',req.body);
  res.json({ok:true});
});

app.listen(PORT,()=>console.log(`[payment-service] REST http://localhost:${PORT} -> SOAP ${WSDL_URL} — ${useSupabase?'Supabase':'memory'} — Swagger http://localhost:${PORT}/api-docs`));
