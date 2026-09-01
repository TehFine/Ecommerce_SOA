const express=require('express'); const cors=require('cors'); const {v4:uuid}=require('uuid');
const swaggerUi=require('swagger-ui-express');
const app=express(); app.use(cors()); app.use(express.json());
const PORT=process.env.PORT||3002;

let products=[
  {id:'prod-42',name:'ASUS VivoBook 15',sku:'ASUS-VB15-2026',category:{id:3,name:'Laptops'},price:15000000,currency:'VND',stock:50,images:['https://cdn.shop.com/prod-42-1.jpg'],rating:4.5,review_count:128,seller:{id:'seller-7',name:'TechStore VN'}},
  {id:'prod-17',name:'Mouse Logitech M331',sku:'LOGI-M331',category:{id:5,name:'Accessories'},price:450000,currency:'VND',stock:200,images:['https://cdn.shop.com/prod-17.jpg'],rating:4.7,review_count:89,seller:{id:'seller-7',name:'TechStore VN'}},
  {id:'prod-99',name:'iPhone 15 Pro',sku:'IP15P-256',category:{id:2,name:'Phones'},price:28000000,currency:'VND',stock:15,images:['https://cdn.shop.com/prod-99.jpg'],rating:4.9,review_count:312,seller:{id:'seller-9',name:'Apple Store'}},
];

// ---------- Dual-mode: memory <-> Supabase ----------
let useSupabase=false; let supabase=null;
if(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)){
  try{ const {createClient}=require('@supabase/supabase-js'); supabase=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY); useSupabase=true; console.log('[product-service] Supabase ON'); }catch(e){ console.log('[product-service] Supabase fail',e.message); }
} else console.log('[product-service] Memory mode');

async function getAllProducts(){ if(!useSupabase) return products; const {data}=await supabase.from('products').select('*'); return data||[]; }
async function findProd(id){ if(!useSupabase) return products.find(x=>x.id===id); const {data}=await supabase.from('products').select('*').eq('id',id).maybeSingle(); return data; }

const swaggerSpec={
  openapi:'3.0.0',
  info:{title:'Product Service API',version:'1.0.0',description:'CRUD + search + stock reservation - Dual-mode memory (docker) <-> Supabase (Render)'},
  servers:[{url:`http://localhost:${PORT}`}],
  paths:{
    '/health':{get:{summary:'Health',tags:['Health'],responses:{'200':{description:'OK'}}}},
    '/api/v1/products':{
      get:{summary:'List products with filter/pagination',tags:['Products'],parameters:[{name:'page',in:'query',schema:{type:'integer',default:1}},{name:'limit',in:'query',schema:{type:'integer',default:10}},{name:'category',in:'query',schema:{type:'string'}},{name:'min_price',in:'query',schema:{type:'integer'}},{name:'max_price',in:'query',schema:{type:'integer'}},{name:'sort',in:'query',schema:{type:'string',example:'price'}},{name:'order',in:'query',schema:{type:'string',enum:['asc','desc']}}],responses:{'200':{description:'OK'}}},
      post:{summary:'Create product',tags:['Products'],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['name','price'],properties:{name:{type:'string'},sku:{type:'string'},price:{type:'integer',example:15000000},stock:{type:'integer'}}}}}},responses:{'201':{description:'Created'}}}
    },
    '/api/v1/products/search':{get:{summary:'Full-text search',tags:['Products'],parameters:[{name:'q',in:'query',required:true,schema:{type:'string'},example:'ASUS'}],responses:{'200':{description:'OK'}}}},
    '/api/v1/products/{id}':{
      get:{summary:'Get product by id',tags:['Products'],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:{'200':{description:'OK'},'404':{description:'Not Found'}}},
      put:{summary:'Update product',tags:['Products'],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:{'200':{description:'OK'}}},
      delete:{summary:'Soft delete',tags:['Products'],parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],responses:{'204':{description:'No Content'}}}
    },
    '/api/v1/internal/reserve':{post:{summary:'Reserve stock (internal)',tags:['Internal'],requestBody:{content:{'application/json':{schema:{type:'object',properties:{product_id:{type:'string'},quantity:{type:'integer'}}}}}},responses:{'200':{description:'OK'}}}},
    '/api/v1/internal/check':{post:{summary:'Check items',tags:['Internal'],requestBody:{content:{'application/json':{schema:{type:'object',properties:{items:{type:'array',items:{type:'object'}}}}}}},responses:{'200':{description:'OK'}}}}
  }
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec,{explorer:true}));
app.get('/api-docs.json',(req,res)=>res.json(swaggerSpec));

app.get('/health',async (req,res)=>{
  const list= await getAllProducts();
  res.json({service:'product-service',status:'ok',mode:useSupabase?'supabase':'memory',count:list.length});
});
app.get('/api/v1/products',async (req,res)=>{
  let {page=1,limit=10,sort,order='asc',category,min_price,max_price}=req.query;
  page=parseInt(page);limit=parseInt(limit);
  let filtered = await getAllProducts();
  if(category) filtered=filtered.filter(p=>p.category?.name?.toLowerCase().includes(category.toLowerCase()) || JSON.stringify(p.category).toLowerCase().includes(category.toLowerCase()));
  if(min_price) filtered=filtered.filter(p=>p.price>=parseInt(min_price));
  if(max_price) filtered=filtered.filter(p=>p.price<=parseInt(max_price));
  if(sort){ filtered.sort((a,b)=> order==='desc'? b[sort]-a[sort] : a[sort]-b[sort]);}
  const total=filtered.length; const total_pages=Math.ceil(total/limit);
  const data=filtered.slice((page-1)*limit, page*limit);
  res.json({data,pagination:{page,limit,total,total_pages}});
});
app.get('/api/v1/products/search',async (req,res)=>{
  const q=(req.query.q||'').toLowerCase();
  const list=await getAllProducts();
  const data=list.filter(p=>p.name.toLowerCase().includes(q)||p.sku.toLowerCase().includes(q));
  res.json({data,total:data.length});
});
app.get('/api/v1/products/:id',async (req,res)=>{
  const p=await findProd(req.params.id);
  if(!p) return res.status(404).json({status:404,detail:'product not found'});
  res.json({data:p});
});
app.post('/api/v1/products',async (req,res)=>{
  const {name,sku,category,price,stock,seller}=req.body;
  if(!name||price==null) return res.status(400).json({status:400,detail:'name and price required'});
  const p={id:'prod-'+uuid().slice(0,8),name,sku:sku||'SKU-'+Date.now(),category:category||{id:1,name:'General'},price,currency:'VND',stock:stock||0,images:req.body.images||[],rating:0,review_count:0,seller:seller||{id:'seller-1',name:'Unknown'}};
  if(!useSupabase) products.push(p);
  else { const {error}=await supabase.from('products').insert(p); if(error) return res.status(500).json({detail:error.message}); }
  res.status(201).json({data:p});
});
app.put('/api/v1/products/:id',async (req,res)=>{
  if(!useSupabase){
    const p=products.find(x=>x.id===req.params.id);
    if(!p) return res.status(404).json({status:404,detail:'not found'});
    Object.assign(p,req.body); return res.json({data:p});
  }
  const {data, error}=await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  if(error) return res.status(404).json({detail:'not found'});
  res.json({data});
});
app.delete('/api/v1/products/:id',async (req,res)=>{
  if(!useSupabase){
    const p=products.find(x=>x.id===req.params.id);
    if(!p) return res.status(404).json({status:404,detail:'not found'});
    p.stock=0; p.deleted=true; return res.status(204).send();
  }
  await supabase.from('products').update({stock:0, deleted:true}).eq('id', req.params.id);
  res.status(204).send();
});
app.post('/api/v1/internal/reserve',async (req,res)=>{
  const {product_id,quantity}=req.body;
  if(!useSupabase){
    const p=products.find(x=>x.id===product_id);
    if(!p) return res.status(404).json({detail:'not found'});
    if(p.stock<quantity) return res.status(422).json({detail:'insufficient stock',stock:p.stock});
    p.stock-=quantity; return res.json({ok:true,remaining:p.stock});
  }
  const p=await findProd(product_id);
  if(!p) return res.status(404).json({detail:'not found'});
  if(p.stock<quantity) return res.status(422).json({detail:'insufficient stock',stock:p.stock});
  const {data}=await supabase.from('products').update({stock: p.stock-quantity}).eq('id', product_id).select().single();
  res.json({ok:true,remaining:data.stock});
});
app.post('/api/v1/internal/check',async (req,res)=>{
  const items=req.body.items||[];
  const list=await getAllProducts();
  const results=items.map(it=>{
    const p=list.find(x=>x.id===it.product_id);
    return {product_id:it.product_id,exists:!!p,stock:p?.stock||0,price:p?.price||0,sufficient: p&&p.stock>=it.quantity};
  });
  res.json({results});
});

app.listen(PORT,()=>console.log(`[product-service] REST http://localhost:${PORT} - ${useSupabase?'Supabase':'memory'} - Swagger http://localhost:${PORT}/api-docs`));
