const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'soa_jwt_secret_2026';
const ACCESS_EXPIRES = '1h';
const REFRESH_EXPIRES = '7d';

// ---------- Dual-mode DB: memory (docker local) <-> Supabase (Render) ----------
let useSupabase = false;
let supabase = null;
const users = []; // fallback memory
const blacklist = new Set();
if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    useSupabase = true;
    console.log('[user-service] Supabase mode ON');
  } catch(e) { console.log('[user-service] Supabase init fail, fallback memory', e.message); }
} else {
  console.log('[user-service] Memory mode (no SUPABASE_URL) - docker local');
}

async function dbFindByEmail(email) {
  if (!useSupabase) return users.find(u=>u.email===email);
  const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (error) { console.log('supabase findByEmail error', error.message); return null; }
  return data;
}
async function dbFindById(id) {
  if (!useSupabase) return users.find(u=>u.id===id);
  const { data } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  return data;
}
async function dbCreate(user) {
  if (!useSupabase) { users.push(user); return user; }
  const { data, error } = await supabase.from('users').insert(user).select().single();
  if (error) throw new Error(error.message);
  return data;
}
async function dbList() {
  if (!useSupabase) return users;
  const { data } = await supabase.from('users').select('*');
  return data||[];
}
async function dbUpdate(id, patch) {
  if (!useSupabase) {
    const u=users.find(x=>x.id===id); if(!u) return null; Object.assign(u, patch); return u;
  }
  const { data } = await supabase.from('users').update(patch).eq('id', id).select().single();
  return data;
}
async function dbDelete(id) {
  if (!useSupabase) { const idx=users.findIndex(x=>x.id===id); if(idx!==-1) users.splice(idx,1); return idx!==-1; }
  const { error } = await supabase.from('users').delete().eq('id', id);
  return !error;
}
async function isBlacklisted(token) {
  if (!useSupabase) return blacklist.has(token);
  const { data } = await supabase.from('jwt_blacklist').select('token').eq('token', token).maybeSingle();
  return !!data;
}
async function addBlacklist(token) {
  if (!useSupabase) blacklist.add(token);
  else await supabase.from('jwt_blacklist').insert({token});
}

function signAccess(user){ return jwt.sign({sub:user.id,email:user.email,roles:user.roles}, JWT_SECRET, {expiresIn: ACCESS_EXPIRES}); }
function signRefresh(user){ return jwt.sign({sub:user.id,type:'refresh'}, JWT_SECRET, {expiresIn: REFRESH_EXPIRES}); }

// ---------- Swagger ----------
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: { title: 'User Service API', version: '1.0.0', description: 'Quản lý người dùng, JWT auth, RBAC — Dual-mode: memory (docker) ↔ Supabase (Render)' },
    servers: [{ url: `http://localhost:${PORT}`, description: 'User Service' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        RegisterRequest: { type: 'object', required: ['email','username','password'], properties: { email:{type:'string',example:'a@shop.com'}, username:{type:'string',example:'buyer1'}, password:{type:'string',example:'123456'}, roles:{type:'array',items:{type:'string'},example:['BUYER']} } },
        LoginRequest: { type: 'object', required: ['email','password'], properties: { email:{type:'string',example:'a@shop.com'}, password:{type:'string',example:'123456'} } }
      }
    }
  },
  apis: ['./server.js'],
};
const swaggerSpec = swaggerJSDoc(swaggerOptions);
swaggerSpec.paths['/health']={get:{summary:'Health',tags:['Health'],responses:{'200':{description:'OK'}}}};
swaggerSpec.paths['/api-docs.json']={get:{summary:'OpenAPI JSON',tags:['Health'],responses:{'200':{description:'OK'}}}};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
app.get('/api-docs.json', (req,res)=> res.json(swaggerSpec));

app.get('/health', async (req,res)=>{
  const count = useSupabase ? (await dbList()).length : users.length;
  res.json({service:'user-service',status:'ok',mode: useSupabase?'supabase':'memory', users:count});
});

app.post('/api/v1/auth/register', async (req,res)=>{
  const {email,username,password,roles} = req.body;
  if(!email||!username||!password) return res.status(400).json({type:'validation',status:400,title:'Bad Request',detail:'email,username,password required'});
  if(await dbFindByEmail(email)) return res.status(409).json({status:409,title:'Conflict',detail:'email already exists'});
  const hash = await bcrypt.hash(password, 12);
  const user = {id:uuid(),email,username,password_hash:hash,roles:roles||['BUYER'],status:'ACTIVE',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  await dbCreate(user);
  const {password_hash,...safe}=user;
  res.status(201).json({data:safe,message:'registered'});
});

app.post('/api/v1/auth/login', async (req,res)=>{
  const {email,password} = req.body;
  const user = await dbFindByEmail(email);
  if(!user) return res.status(401).json({status:401,title:'Unauthorized',detail:'invalid credentials'});
  const ok = await bcrypt.compare(password, user.password_hash);
  if(!ok) return res.status(401).json({status:401,title:'Unauthorized',detail:'invalid credentials'});
  if(user.status!=='ACTIVE') return res.status(403).json({status:403,title:'Forbidden',detail:`status ${user.status}`});
  const access = signAccess(user);
  const refresh = signRefresh(user);
  res.json({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,user:{id:user.id,email:user.email,roles:user.roles}});
});

app.post('/api/v1/auth/refresh', async (req,res)=>{
  const {refresh_token} = req.body;
  if(!refresh_token) return res.status(400).json({status:400,detail:'refresh_token required'});
  if(await isBlacklisted(refresh_token)) return res.status(401).json({status:401,detail:'token revoked'});
  try{
    const payload = jwt.verify(refresh_token, JWT_SECRET);
    if(payload.type!=='refresh') throw new Error('not refresh');
    const user = await dbFindById(payload.sub);
    if(!user) throw new Error('user not found');
    const newAccess = signAccess(user);
    res.json({access_token:newAccess,token_type:'Bearer',expires_in:3600});
  }catch(e){ res.status(401).json({status:401,detail:'invalid refresh_token: '+e.message});}
});

app.get('/api/v1/users/:id', async (req,res)=>{
  const u = await dbFindById(req.params.id);
  if(!u) return res.status(404).json({status:404,detail:'user not found'});
  const {password_hash,...safe}=u; res.json({data:safe});
});
app.get('/api/v1/users', async (req,res)=>{
  const list = await dbList();
  res.json({data:list.map(({password_hash,...s})=>s),total:list.length});
});
app.put('/api/v1/users/:id', async (req,res)=>{
  const u=await dbUpdate(req.params.id, {...req.body, updated_at:new Date().toISOString()});
  if(!u) return res.status(404).json({status:404,detail:'not found'});
  const {password_hash,...safe}=u; res.json({data:safe});
});
app.delete('/api/v1/users/:id', async (req,res)=>{
  const ok=await dbDelete(req.params.id);
  if(!ok) return res.status(404).json({status:404,detail:'not found'});
  res.status(204).send();
});
app.post('/api/v1/users/:id/roles', async (req,res)=>{
  const u=await dbFindById(req.params.id);
  if(!u) return res.status(404).json({status:404,detail:'not found'});
  const {role}=req.body;
  const roles = [...(u.roles||[]), role];
  const updated = await dbUpdate(req.params.id, {roles});
  res.status(201).json({data:updated.roles||roles});
});

// internal validate endpoint cho Order Service
app.get('/api/v1/internal/validate/:id', async (req,res)=>{
  const u=await dbFindById(req.params.id);
  res.json({exists:!!u,active:u?.status==='ACTIVE'});
});

app.listen(PORT, ()=>console.log(`[user-service] REST http://localhost:${PORT} — ${useSupabase?'Supabase':'memory'} — Swagger http://localhost:${PORT}/api-docs`));
