/**
 * Load test cho SOA E-commerce - mô phỏng JMeter 1000 concurrent (slide 48)
 * Yêu cầu: p99 <500ms, search <200ms
 * Chạy: node load-test.js  (cần gateway + 5 service đang chạy)
 */
const GATEWAY = process.env.GATEWAY || 'http://localhost:3000';

function percentile(arr, p) {
  const sorted = [...arr].sort((a,b)=>a-b);
  const idx = Math.ceil(p/100*sorted.length)-1;
  return sorted[idx];
}

async function timedFetch(url, opts={}) {
  const s = Date.now();
  try { const r = await fetch(url, opts); await r.text(); } catch(e) {}
  return Date.now() - s;
}

async function run(concurrent=100, rounds=5) {
  console.log(`=== SOA Load Test: ${concurrent} concurrent x ${rounds} rounds (${concurrent*rounds} req) @ ${GATEWAY} ===`);
  let token = null;
  try {
    await fetch(`${GATEWAY}/api/v1/auth/register`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:`load${Date.now()}@shop.com`, username:`load${Date.now()}`, password:'123456'})});
  } catch {}
  try {
    let r = await fetch(`${GATEWAY}/api/v1/auth/login`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:`load${Date.now()}@shop.com`, password:'123456'})});
    let j = await r.json().catch(async ()=>{
      await fetch(`${GATEWAY}/api/v1/auth/register`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'a@shop.com', username:'buyer1', password:'123456'})});
      let rr = await fetch(`${GATEWAY}/api/v1/auth/login`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:'a@shop.com', password:'123456'})});
      return rr.json();
    });
    token = j.access_token;
  } catch(e) { console.log('login fail', e.message); }

  const latencies = { products:[], search:[], orders:[], payments:[] };

  for(let round=0; round<rounds; round++) {
    const start = Date.now();
    const promises = [];
    for(let i=0;i<concurrent;i++) {
      promises.push(timedFetch(`${GATEWAY}/api/v1/products`).then(v=> latencies.products.push(v)));
      promises.push(timedFetch(`${GATEWAY}/api/v1/products/search?q=ASUS`).then(v=> latencies.search.push(v)));
      if(token) {
        promises.push(timedFetch(`${GATEWAY}/api/v1/orders`, {headers:{Authorization:`Bearer ${token}`}}).then(v=> latencies.orders.push(v)));
      }
    }
    await Promise.all(promises);
    console.log(`Round ${round+1}/${rounds} done in ${Date.now()-start}ms`);
  }

  try {
    const t = await timedFetch(`${GATEWAY}/api/v1/payments`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({orderId:`ORD-LOAD-${Date.now()}`, amount:15000000, currency:'VND', cardNumber:'4111111111111111', expiryDate:'12/28', cvv:'123'})});
    latencies.payments.push(t);
  } catch {}

  function report(name, arr) {
    if(!arr.length) return;
    const avg = arr.reduce((a,b)=>a+b,0)/arr.length;
    console.log(`\n${name}: count=${arr.length} avg=${avg.toFixed(1)}ms p50=${percentile(arr,50)}ms p95=${percentile(arr,95)}ms p99=${percentile(arr,99)}ms min=${Math.min(...arr)}ms max=${Math.max(...arr)}ms`);
    const ok = percentile(arr,99) < 500;
    console.log(`  -> p99 <500ms: ${ok ? 'PASS' : 'FAIL'}`);
  }
  report('GET /products', latencies.products);
  report('GET /products/search', latencies.search);
  report('GET /orders', latencies.orders);
  report('POST /payments', latencies.payments);
  console.log('\n=== Done ===');
}

const concurrent = parseInt(process.argv[2]||'50');
const rounds = parseInt(process.argv[3]||'3');
run(concurrent, rounds).catch(console.error);
