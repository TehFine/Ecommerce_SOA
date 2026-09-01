import http from 'k6/http';
import { check, sleep } from 'k6';

// k6 run --vus 100 --duration 30s k6-test.js
// Yêu cầu slide 48: 1000 concurrent, p99 <500ms
export const options = {
  vus: 100,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(99)<500', 'p(50)<120'],
    http_req_failed: ['rate<0.01'],
  },
};

const GATEWAY = __ENV.GATEWAY || 'http://localhost:3000';

export function setup() {
  // register + login
  const email = `k6_${Date.now()}@shop.com`;
  http.post(`${GATEWAY}/api/v1/auth/register`, JSON.stringify({email, username: email, password: '123456'}), {headers:{'Content-Type':'application/json'}});
  const login = http.post(`${GATEWAY}/api/v1/auth/login`, JSON.stringify({email, password: '123456'}), {headers:{'Content-Type':'application/json'}});
  const token = login.json('access_token');
  return { token, email };
}

export default function(data) {
  const token = data.token;
  let r = http.get(`${GATEWAY}/api/v1/products`);
  check(r, {'products 200': (r)=> r.status===200});
  r = http.get(`${GATEWAY}/api/v1/products/search?q=ASUS`);
  check(r, {'search 200': (r)=> r.status===200});
  if(token) {
    r = http.get(`${GATEWAY}/api/v1/orders`, {headers:{Authorization: `Bearer ${token}`}});
    check(r, {'orders 200': (r)=> r.status===200});
  }
  sleep(0.1);
}

export function handleSummary(data) {
  return {'stdout': `\nK6 p99=${data.metrics.http_req_duration.values['p(99)'].toFixed(1)}ms p50=${data.metrics.http_req_duration.values['med'].toFixed(1)}ms failed=${data.metrics.http_req_failed.values.rate}\n`};
}
