const express=require('express');
const soap=require('soap');
const fs=require('fs');
const path=require('path');
const {v4:uuid}=require('uuid');
const swaggerUi=require('swagger-ui-express');
const swaggerJSDoc=require('swagger-jsdoc');

const PORT=process.env.PORT||3004;
const app=express();

const wsdl = fs.readFileSync(path.join(__dirname,'payment.wsdl'),'utf8');
const transactions=new Map(); // txId -> {orderId,amount,currency,status}

// ---------- Swagger cho SOAP gateway (mô tả REST + WSDL) ----------
const swaggerSpec={
  openapi:'3.0.0',
  info:{title:'Payment SOAP Gateway (WSDL)',version:'1.0.0',description:'SOAP Gateway expose WSDL — 3 operations processPayment, checkPaymentStatus, refundPayment + WS-Security UsernameToken. Test SOAP qua ?wsdl, test REST health qua /api-docs. Thử SOAP bằng SoapUI hoặc curl XML.'},
  servers:[{url:`http://localhost:${PORT}`}],
  paths:{
    '/health':{get:{summary:'Health SOAP gateway',tags:['Health'],responses:{'200':{description:'OK'}}}},
    '/wsdl':{get:{summary:'WSDL endpoint (SOAP) — append ?wsdl để lấy XML',tags:['SOAP'],parameters:[{name:'wsdl',in:'query',schema:{type:'string'}}],responses:{'200':{description:'WSDL XML'}}}},
    '/wsdl?wsdl':{get:{summary:'WSDL XML (alias)',tags:['SOAP'],responses:{'200':{description:'WSDL XML'}}}},
    '/api-docs.json':{get:{summary:'OpenAPI JSON',tags:['Health'],responses:{'200':{description:'OK'}}}}
  }
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec,{explorer:true}));
app.get('/api-docs.json',(req,res)=>res.json(swaggerSpec));

// WS-Security mock validation
function validateSecurity(headers){
  return true;
}

const service={
  PaymentGatewayService:{
    PaymentGatewayPort:{
      processPayment(args, cb, headers){
        if(!validateSecurity(headers)){
          return cb({Fault:{faultcode:'soap:Client',faultstring:'WS-Security validation failed'}});
        }
        const {orderId,amount,currency,cardNumber}=args;
        if(!orderId||!amount||!cardNumber) {
          return cb({Fault:{faultcode:'soap:Client',faultstring:'Missing required fields',detail:'orderId,amount,cardNumber required'}});
        }
        if(String(cardNumber).startsWith('4000')){
          return cb({Fault:{faultcode:'soap:Client',faultstring:'Payment declined',detail:'Card declined by bank'}});
        }
        const txId='TXN-'+uuid().slice(0,8).toUpperCase();
        transactions.set(txId,{orderId,amount,currency,status:'SUCCESS',created:new Date().toISOString()});
        console.log(`[SOAP] processPayment ${orderId} -> ${txId} amount=${amount}`);
        cb({transactionId:txId,status:'SUCCESS',message:'Payment processed',timestamp:new Date().toISOString()});
      },
      checkPaymentStatus(args, cb){
        const rec=transactions.get(args.transactionId);
        if(!rec) return cb({Fault:{faultcode:'soap:Client',faultstring:'Transaction not found'}});
        cb({transactionId:args.transactionId,status:rec.status,amount:rec.amount});
      },
      refundPayment(args, cb){
        const rec=transactions.get(args.transactionId);
        if(!rec) return cb({Fault:{faultcode:'soap:Client',faultstring:'Transaction not found'}});
        rec.status='REFUNDED';
        const refundId='REF-'+uuid().slice(0,8).toUpperCase();
        console.log(`[SOAP] refund ${args.transactionId} -> ${refundId}`);
        cb({transactionId:args.transactionId,status:'REFUNDED',refundId});
      }
    }
  }
};

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health SOAP gateway
 *     tags: [Health]
 *     responses: { 200: {description: OK}}
 */
/**
 * @swagger
 * /wsdl:
 *   get:
 *     summary: WSDL endpoint (SOAP) — append ?wsdl để lấy định nghĩa XML
 *     tags: [SOAP]
 *     parameters: [{ name: wsdl, in: query, schema:{type:string}}]
 *     responses: { 200: {description: WSDL XML}}
 */
app.get('/health',(req,res)=>res.json({service:'payment-soap-gateway',status:'ok',wsdl:'/wsdl?wsdl',transactions:transactions.size}));
const server=app.listen(PORT,()=>{
  soap.listen(server,'/wsdl',service,wsdl,()=>{
    console.log(`[payment-soap-gateway] SOAP WSDL http://localhost:${PORT}/wsdl?wsdl — Swagger http://localhost:${PORT}/api-docs`);
  });
});
