const express=require('express'); const cors=require('cors');
const swaggerUi=require('swagger-ui-express');
const app=express(); app.use(cors()); app.use(express.json());
const PORT=process.env.PORT||3006;
const RABBITMQ_URL=process.env.RABBITMQ_URL||'amqp://localhost:5672';

let logs=[];
async function send(channel, event, data){
  const msg=`[${new Date().toISOString()}] ${event} -> ${data.id||data.orderId||JSON.stringify(data).slice(0,80)}`;
  const entry={event,data,at:new Date().toISOString(),channel};
  await dbAddLog(entry);
  console.log(`[notification] ${msg} via ${channel}`);
}

const swaggerSpec={
  openapi:'3.0.0',
  info:{title:'Notification Service API (Event-driven)',version:'1.0.0',description:'Subscribe RabbitMQ topic ecommerce: OrderCreated/Confirmed/Shipped/Delivered, PaymentSuccess'},
  servers:[{url:`http://localhost:${PORT}`}],
  paths:{
    '/health':{get:{summary:'Health',tags:['Health'],responses:{'200':{description:'OK'}}}},
    '/api/v1/notifications':{get:{summary:'List notifications (50 latest)',tags:['Notifications'],responses:{'200':{description:'OK'}}}},
    '/api/v1/events':{post:{summary:'HTTP fallback for publish event',tags:['Events'],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['event'],properties:{event:{type:'string',example:'OrderCreated'},data:{type:'object'}}}}}},responses:{'200':{description:'OK'}}}}
  }
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec,{explorer:true}));
app.get('/api-docs.json',(req,res)=>res.json(swaggerSpec));

app.get('/health',async (req,res)=>{ const list=await dbListLogs(); res.json({service:'notification-service',status:'ok',mode:useSupabase2?'supabase':'memory',events:list.length,subscribed:['OrderCreated','PaymentSuccess','OrderShipped','OrderDelivered','OrderConfirmed','OrderCancelled','LowStock']}); });
app.get('/api/v1/notifications',async (req,res)=>{ const list=await dbListLogs(); const data=useSupabase2?list:logs.slice(-50); res.json({data,total:useSupabase2?list.length:logs.length}); });
app.post('/api/v1/events',async (req,res)=>{
  const {event,data}=req.body;
  if(event) await send('HTTP-fallback',event,data||req.body);
  res.json({ok:true});
});

async function initRabbit(){
  try{
    const amqp=require('amqplib');
    const conn=await amqp.connect(RABBITMQ_URL);
    const ch=await conn.createChannel();
    await ch.assertExchange('ecommerce','topic',{durable:true});
    const q=await ch.assertQueue('notification-queue',{durable:true});
    await ch.bindQueue(q.queue,'ecommerce','Order*');
    await ch.bindQueue(q.queue,'ecommerce','Payment*');
    await ch.bindQueue(q.queue,'ecommerce','LowStock');
    console.log('[notification] subscribed to RabbitMQ ecommerce topic');
    ch.consume(q.queue, async msg=>{
      if(!msg) return;
      const event=msg.fields.routingKey;
      const data=JSON.parse(msg.content.toString());
      const channelMap={OrderCreated:'Email: Order confirmation',PaymentSuccess:'SMS/Email: receipt',OrderShipped:'Push: tracking',OrderDelivered:'Email: feedback request',LowStock:'Email to seller'};
      await send(channelMap[event]||'Email',event,data);
      ch.ack(msg);
    });
  }catch(e){ console.log('[notification] RabbitMQ unavailable, using HTTP fallback',e.message);}
}

initRabbit().then(()=> app.listen(PORT,()=>console.log(`[notification-service] http://localhost:${PORT} event-driven - Swagger http://localhost:${PORT}/api-docs`)));
