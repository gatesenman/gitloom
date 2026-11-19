// Fixture repositories with real git histories for 变更可视化 tests, e2e and screenshots.
//   node scripts/viz-fixtures.mjs <dir>       → <dir>/ts-service, <dir>/py-pkg, <dir>/java-app, <dir>/big
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'

const sh = (cwd, c) => { const r = spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(`${c}\n${r.stderr}`); return r.stdout.trim() }
const w = (root, files) => { for (const [p, s] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s.replace(/^\n/, '')) } }
const init = (dir) => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); sh(dir, 'git init -q -b main && git config user.email viz@gitloom.dev && git config user.name Viz && git config commit.gpgsign false') }
const commit = (dir, msg, date) => sh(dir, `git add -A && GIT_AUTHOR_DATE="${date}" GIT_COMMITTER_DATE="${date}" git commit -qm "${msg}"`)

/** TypeScript order service: v1 api → repo; v2 adds a service layer, splits the repo module, extends the state machine. */
export function makeTsService(dir) {
  init(dir)
  w(dir, {
    'package.json': '{ "name": "order-service", "version": "1.0.0" }\n',
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n',
    'src/api/orders.ts': `
import { findOrder, saveOrder, listOrders } from '../db/orderRepo'
import { reduce, type OrderStatus } from '../state/orderState'
import { log } from '../util/log'

export function getOrder(id: string) {
  const o = findOrder(id)
  if (!o) throw new Error('not found')
  return o
}

export function payOrder(id: string) {
  const o = getOrder(id)
  o.status = reduce(o.status, 'pay')
  saveOrder(o)
  log('paid ' + id)
  return o
}

export function shipOrder(id: string) {
  const o = getOrder(id)
  if (o.status !== 'paid') throw new Error('not paid')
  o.status = reduce(o.status, 'ship')
  saveOrder(o)
  return o
}

export function report() {
  let total = 0
  for (const o of listOrders()) total += o.amount
  return total
}
`,
    'src/db/orderRepo.ts': `
import { Order } from '../model/order'
import { log } from '../util/log'
const store = new Map<string, Order>()

export function findOrder(id: string): Order | undefined { return store.get(id) }
export function saveOrder(o: Order): void { store.set(o.id, o); log('saved ' + o.id) }
export function listOrders(): Order[] { return [...store.values()] }
export function deleteOrder(id: string): void { store.delete(id) }
`,
    'src/model/order.ts': `
import type { OrderStatus } from '../state/orderState'
export class Order {
  id: string
  amount: number
  status: OrderStatus = 'new'
  constructor(id: string, amount: number) { this.id = id; this.amount = amount }
  total(): number { return this.amount }
}
`,
    'src/state/orderState.ts': `
export type OrderStatus = 'new' | 'paid' | 'shipped'
export type OrderEvent = 'pay' | 'ship'

export function reduce(s: OrderStatus, e: OrderEvent): OrderStatus {
  switch (s) {
    case 'new':
      if (e === 'pay') return 'paid'
      return s
    case 'paid':
      if (e === 'ship') return 'shipped'
      return s
    default:
      return s
  }
}
`,
    'src/util/log.ts': `export function log(msg: string): void { console.log('[orders]', msg) }\n`,
    'src/ui/OrderPage.tsx': `
import { getOrder, payOrder } from '../api/orders'
export function OrderPage({ id }: { id: string }) {
  const o = getOrder(id)
  const onPay = () => payOrder(id)
  return <button onClick={onPay}>{o.status}</button>
}
`
  })
  commit(dir, 'feat: 订单服务初版（API 直连仓储）', '2026-09-01T10:00:00+08:00')
  // v2: refactor — service layer, repo split, state machine extended
  sh(dir, 'git checkout -q -b refactor/service-layer')
  rmSync(join(dir, 'src/db/orderRepo.ts'))
  w(dir, {
    'src/api/orders.ts': `
import { OrderService } from '../services/orderService'
import { log } from '../util/log'

const service = new OrderService()

export function getOrder(id: string) {
  return service.get(id)
}

export function payOrder(id: string) {
  const o = service.pay(id)
  log('paid ' + id)
  return o
}

export function shipOrder(id: string) {
  return service.ship(id)
}

export function cancelOrder(id: string, reason: string) {
  if (!reason) throw new Error('reason required')
  return service.cancel(id, reason)
}

export function report() {
  return service.total()
}
`,
    'src/services/orderService.ts': `
import { findOrder, listOrders } from '../db/orderReader'
import { saveOrder } from '../db/orderWriter'
import { reduce } from '../state/orderState'
import { Order } from '../model/order'
import { emit } from '../util/events'

export class OrderService {
  get(id: string): Order {
    const o = findOrder(id)
    if (!o) throw new Error('not found')
    return o
  }

  pay(id: string): Order {
    const o = this.get(id)
    o.status = reduce(o.status, 'pay')
    saveOrder(o)
    emit('order:paid', o)
    return o
  }

  ship(id: string): Order {
    const o = this.get(id)
    if (o.status !== 'paid') throw new Error('not paid')
    o.status = reduce(o.status, 'ship')
    saveOrder(o)
    return o
  }

  cancel(id: string, reason: string): Order {
    const o = this.get(id)
    try {
      o.status = reduce(o.status, 'cancel')
      o.cancelReason = reason
      saveOrder(o)
    } catch (e) {
      emit('order:cancel-failed', o)
      throw e
    }
    return o
  }

  total(): number {
    let total = 0
    for (const o of listOrders()) {
      if (o.status === 'cancelled') continue
      total += o.total()
    }
    return total
  }
}
`,
    'src/db/orderReader.ts': `
import { Order } from '../model/order'
import { store } from './store'
export function findOrder(id: string): Order | undefined { return store.get(id) }
export function listOrders(): Order[] { return [...store.values()] }
`,
    'src/db/orderWriter.ts': `
import { Order } from '../model/order'
import { store } from './store'
import { log } from '../util/log'
export function saveOrder(o: Order): void { store.set(o.id, o); log('saved ' + o.id) }
`,
    'src/db/store.ts': `
import { Order } from '../model/order'
export const store = new Map<string, Order>()
`,
    'src/model/order.ts': `
import type { OrderStatus } from '../state/orderState'
export class Order {
  id: string
  amount: number
  status: OrderStatus = 'new'
  cancelReason?: string
  discount = 0
  constructor(id: string, amount: number) { this.id = id; this.amount = amount }
  total(): number { return this.amount - this.discount }
  isOpen(): boolean { return this.status === 'new' || this.status === 'paid' }
}
`,
    'src/state/orderState.ts': `
export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled' | 'refunded'
export type OrderEvent = 'pay' | 'ship' | 'cancel' | 'refund'

export function reduce(s: OrderStatus, e: OrderEvent): OrderStatus {
  switch (s) {
    case 'new':
      if (e === 'pay') return 'paid'
      if (e === 'cancel') return 'cancelled'
      return s
    case 'paid':
      if (e === 'ship') return 'shipped'
      if (e === 'refund') return 'refunded'
      return s
    default:
      return s
  }
}
`,
    'src/util/events.ts': `
type Handler = (payload: unknown) => void
const handlers = new Map<string, Handler[]>()
export function on(name: string, h: Handler): void { handlers.set(name, [...(handlers.get(name) ?? []), h]) }
export function emit(name: string, payload: unknown): void { for (const h of handlers.get(name) ?? []) h(payload) }
`,
    'src/ui/OrderPage.tsx': `
import { getOrder, payOrder, cancelOrder } from '../api/orders'
export function OrderPage({ id }: { id: string }) {
  const o = getOrder(id)
  const onPay = () => payOrder(id)
  const onCancel = () => cancelOrder(id, 'user')
  return <div><button onClick={onPay}>{o.status}</button><button onClick={onCancel}>取消</button></div>
}
`
  })
  commit(dir, 'refactor: 引入服务层、拆分仓储、订单状态机增加取消/退款', '2026-09-03T15:30:00+08:00')
  sh(dir, 'git checkout -q main')
  // a small unrelated change on main so refs / range differ from a single commit
  w(dir, { 'README.md': '# order-service\n' })
  commit(dir, 'docs: README', '2026-09-02T09:00:00+08:00')
  sh(dir, 'git checkout -q refactor/service-layer')
  // uncommitted work for the working-tree scope
  w(dir, { 'src/util/log.ts': `export function log(msg: string, level = 'info'): void { console.log('[orders]', level, msg) }\nexport function warn(msg: string): void { log(msg, 'warn') }\n` })
  return dir
}

/** Python package: adds a subclass, an Enum member and a new service function. */
export function makePy(dir) {
  init(dir)
  w(dir, {
    'shop/__init__.py': '',
    'shop/models.py': `
from enum import Enum

class Status(Enum):
    ACTIVE = 1
    BLOCKED = 2

class User:
    def __init__(self, name):
        self.name = name
        self.status = Status.ACTIVE

    def block(self):
        self.status = Status.BLOCKED
`,
    'shop/service.py': `
from .models import User, Status

def register(name):
    u = User(name)
    return u

def block_user(u):
    if u.status == Status.ACTIVE:
        u.block()
    return u
`
  })
  commit(dir, 'feat: 用户模型', '2026-09-05T10:00:00+08:00')
  w(dir, {
    'shop/models.py': `
from enum import Enum

class Status(Enum):
    ACTIVE = 1
    BLOCKED = 2
    DELETED = 3

class User:
    def __init__(self, name, email=None):
        self.name = name
        self.email = email
        self.status = Status.ACTIVE

    def block(self):
        self.status = Status.BLOCKED

    def delete(self):
        self.status = Status.DELETED

class Admin(User):
    def __init__(self, name):
        super().__init__(name)
        self.level = 1

    def promote(self):
        self.level += 1
`,
    'shop/service.py': `
from .models import User, Admin, Status
from .audit import record

def register(name, email=None, admin=False):
    u = Admin(name) if admin else User(name, email)
    record("register", u)
    return u

def block_user(u):
    if u.status == Status.ACTIVE:
        u.block()
        record("block", u)
    elif u.status == Status.DELETED:
        raise ValueError("deleted")
    return u

def delete_user(u):
    for _ in range(3):
        try:
            u.delete()
            break
        except Exception:
            continue
    record("delete", u)
`,
    'shop/audit.py': `
log = []

def record(action, user):
    log.append((action, user.name))
`
  })
  commit(dir, 'feat: 管理员、删除状态与审计日志', '2026-09-06T10:00:00+08:00')
  return dir
}

/** Java project: controller → service interface/impl; v2 adds a payment gateway and a status enum value. */
export function makeJava(dir) {
  init(dir)
  const p = 'src/main/java/com/acme/shop/'
  w(dir, {
    [p + 'OrderController.java']: `
package com.acme.shop;

public class OrderController {
    private final OrderService service;
    public OrderController(OrderService service) { this.service = service; }
    public String create(String id) {
        Order o = service.create(id);
        return o.getId();
    }
}
`,
    [p + 'OrderService.java']: `
package com.acme.shop;
public interface OrderService { Order create(String id); }
`,
    [p + 'OrderServiceImpl.java']: `
package com.acme.shop;

public class OrderServiceImpl implements OrderService {
    public Order create(String id) {
        Order o = new Order(id);
        o.setStatus(Status.NEW);
        return o;
    }
}
`,
    [p + 'Order.java']: `
package com.acme.shop;
public class Order {
    private String id;
    private Status status;
    public Order(String id) { this.id = id; }
    public String getId() { return id; }
    public void setStatus(Status s) { this.status = s; }
}
`,
    [p + 'Status.java']: `
package com.acme.shop;
public enum Status { NEW, DONE }
`
  })
  commit(dir, 'feat: 订单下单', '2026-09-07T10:00:00+08:00')
  w(dir, {
    [p + 'OrderController.java']: `
package com.acme.shop;

public class OrderController {
    private final OrderService service;
    public OrderController(OrderService service) { this.service = service; }
    public String create(String id) {
        Order o = service.create(id);
        return o.getId();
    }
    public String pay(String id, long cents) {
        Order o = service.pay(id, cents);
        return o.getStatus().name();
    }
}
`,
    [p + 'OrderService.java']: `
package com.acme.shop;
public interface OrderService { Order create(String id); Order pay(String id, long cents); }
`,
    [p + 'OrderServiceImpl.java']: `
package com.acme.shop;

public class OrderServiceImpl implements OrderService {
    private final PaymentGateway gateway = new PaymentGateway();
    public Order create(String id) {
        Order o = new Order(id);
        o.setStatus(Status.NEW);
        return o;
    }
    public Order pay(String id, long cents) {
        Order o = new Order(id);
        if (gateway.charge(id, cents)) {
            o.setStatus(Status.PAID);
        } else {
            o.setStatus(Status.FAILED);
        }
        return o;
    }
}
`,
    [p + 'PaymentGateway.java']: `
package com.acme.shop;
public class PaymentGateway {
    public boolean charge(String id, long cents) { return cents > 0; }
}
`,
    [p + 'Order.java']: `
package com.acme.shop;
public class Order {
    private String id;
    private Status status;
    public Order(String id) { this.id = id; }
    public String getId() { return id; }
    public Status getStatus() { return status; }
    public void setStatus(Status s) { this.status = s; }
}
`,
    [p + 'Status.java']: `
package com.acme.shop;
public enum Status { NEW, PAID, FAILED, DONE }
`
  })
  commit(dir, 'feat: 支付网关与支付状态', '2026-09-08T10:00:00+08:00')
  return dir
}

/** Synthetic big repo for perf: n TS modules in 30 folders with cross imports; the 2nd commit touches `touch` files. */
export function makeBig(dir, n = 1500, touch = 60) {
  init(dir)
  const files = {}
  const mod = (i, v) => {
    const f = `pkg${i % 30}/mod${i}.ts`
    const deps = [((i * 7) % n), ((i * 13 + 5) % n), ((i * 31 + 11) % n)].filter((d) => d !== i)
    const imp = deps.map((d) => `import { fn${d} } from '../pkg${d % 30}/mod${d}'`).join('\n')
    const body = `export function fn${i}(x: number): number {\n  let y = x\n  if (x > ${i}) y = fn${deps[0]}(x - 1)\n  for (let k = 0; k < 3; k++) y += ${v ? `fn${deps[1]}(k)` : 'k'}\n  return y\n}\nexport class C${i} { v = ${i}; run(): number { return fn${i}(this.v) }${v ? `\n  extra(): number { return fn${deps[2]}(${i}) }` : ''} }\n`
    return [f, `${imp}\n${body}`]
  }
  for (let i = 0; i < n; i++) { const [f, s] = mod(i, false); files[f] = s }
  w(dir, files)
  commit(dir, 'big: initial', '2026-09-10T10:00:00+08:00')
  const ch = {}
  for (let i = 0; i < touch; i++) { const [f, s] = mod(i * Math.floor(n / touch), true); ch[f] = s }
  w(dir, ch)
  commit(dir, `big: touch ${touch} modules`, '2026-09-11T10:00:00+08:00')
  return dir
}

/** 0.5.1 code-map fixture: a web shop with hub files (config.ts imported by 12 files, http.ts by 7), tags v1.0 / v1.1
 *  and a branch feature/coupons (checked out) that edits the hub, adds a coupons feature, deletes a legacy module,
 *  renames lib/fmt.ts → lib/format.ts and touches docs / assets. */
export function makeHub(dir) {
  init(dir)
  const feats = ['cart', 'checkout', 'catalog', 'account', 'search']
  const files = {
    'package.json': '{ "name": "web-shop", "version": "1.0.0" }\n',
    'docs/README.md': '# Web shop\n\nDemo repository for GitLoom code map.\n',
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n',
    'src/config.ts': `export const config = {\n  apiBase: '/api',\n  currency: 'CNY',\n  pageSize: 20\n}\nexport function flag(name: string): boolean { return name === 'beta' }\n`,
    'src/lib/http.ts': `import { config } from '../config'\nexport async function get(path: string): Promise<unknown> { return fetch(config.apiBase + path).then((r) => r.json()) }\nexport async function post(path: string, body: unknown): Promise<unknown> { return fetch(config.apiBase + path, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json()) }\n`,
    'src/lib/fmt.ts': `import { config } from '../config'\nexport function money(n: number): string { return n.toFixed(2) + ' ' + config.currency }\n`,
    'src/features/legacy/oldPromo.ts': `import { config } from '../../config'\nexport function promo(total: number): number { return config.pageSize > 10 ? total * 0.95 : total }\n`,
    'src/ui/App.tsx': `import { renderCart } from '../features/cart/cartView'\nimport { renderCheckout } from '../features/checkout/checkoutView'\nimport { config } from '../config'\nexport function App() { return [renderCart(), renderCheckout(), config.apiBase] }\n`,
    'src/ui/Header.tsx': `import { config } from '../config'\nimport { money } from '../lib/fmt'\nexport function Header() { return 'Shop ' + config.currency + money(0) }\n`
  }
  for (const f of feats) {
    files[`src/features/${f}/${f}Api.ts`] = `import { get, post } from '../../lib/http'\nimport { config } from '../../config'\nexport function load${f}(id: string) { return get('/${f}/' + id + '?n=' + config.pageSize) }\nexport function save${f}(x: unknown) { return post('/${f}', x) }\n`
    files[`src/features/${f}/${f}View.ts`] = `import { load${f} } from './${f}Api'\nimport { money } from '../../lib/fmt'\nimport { config } from '../../config'\nexport function render${f[0].toUpperCase() + f.slice(1)}() { load${f}('1'); return money(1) + config.currency }\n`
  }
  files['src/features/checkout/checkoutView.ts'] = `import { loadcheckout } from './checkoutApi'\nimport { money } from '../../lib/fmt'\nimport { promo } from '../legacy/oldPromo'\nimport { config } from '../../config'\nexport function renderCheckout() { loadcheckout('1'); return money(promo(100)) + config.currency }\n`
  w(dir, files)
  commit(dir, 'shop: v1', '2026-09-01T10:00:00+08:00')
  sh(dir, 'git tag -a v1.0 -m v1.0')
  w(dir, { 'docs/README.md': '# Web shop\n\nDemo repository for GitLoom code map.\n\n## Run\n\nnpm start\n' })
  commit(dir, 'docs: run section', '2026-09-05T10:00:00+08:00')
  sh(dir, 'git tag -a v1.1 -m v1.1')
  sh(dir, 'git checkout -q -b feature/coupons')
  sh(dir, 'git rm -q src/features/legacy/oldPromo.ts && git mv src/lib/fmt.ts src/lib/format.ts')
  const re = (p, a, b) => { const t = readFileSync(join(dir, p), 'utf8'); writeFileSync(join(dir, p), t.split(a).join(b)) }
  for (const f of ['src/ui/Header.tsx', ...feats.map((f) => `src/features/${f}/${f}View.ts`)]) re(f, 'lib/fmt', 'lib/format')
  w(dir, {
    'src/config.ts': `export const config = {\n  apiBase: '/api/v2',\n  currency: 'CNY',\n  pageSize: 20,\n  coupons: { enabled: true, maxPerOrder: 2 }\n}\nexport function flag(name: string): boolean { return name === 'beta' || (name === 'coupons' && config.coupons.enabled) }\n`,
    'src/features/coupons/coupon.ts': `import { config } from '../../config'\nexport interface Coupon { code: string; off: number }\nexport function valid(c: Coupon[]): Coupon[] { return c.slice(0, config.coupons.maxPerOrder) }\n`,
    'src/features/coupons/couponService.ts': `import { post } from '../../lib/http'\nimport { valid, type Coupon } from './coupon'\nexport function applyCoupons(total: number, cs: Coupon[]): number { const v = valid(cs); post('/coupons/use', v); return v.reduce((t, c) => t - c.off, total) }\n`,
    'src/features/checkout/checkoutView.ts': `import { loadcheckout } from './checkoutApi'\nimport { money } from '../../lib/format'\nimport { applyCoupons } from '../coupons/couponService'\nimport { config, flag } from '../../config'\nexport function renderCheckout() {\n  loadcheckout('1')\n  const total = flag('coupons') ? applyCoupons(100, [{ code: 'NEW', off: 10 }]) : 100\n  return money(total) + config.currency\n}\n`,
    'docs/coupons.md': '# Coupons\n\nUp to two coupons per order.\n'
  })
  commit(dir, 'feat: coupons', '2026-09-08T10:00:00+08:00')
  return dir
}

if (process.argv[1] && process.argv[1].endsWith('viz-fixtures.mjs')) {
  const root = process.argv[2] || '/tmp/gitloom-viz-fixtures'
  mkdirSync(root, { recursive: true })
  makeTsService(join(root, 'ts-service')); makePy(join(root, 'py-pkg')); makeJava(join(root, 'java-app')); makeHub(join(root, 'web-shop'))
  if (!process.env.NO_BIG) makeBig(join(root, 'big'), Number(process.env.BIG_N || 1500))
  console.log('fixtures in', root)
}
