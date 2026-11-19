// mock AI answer shared by unit tests (same shape as the e2e mock server)
export const AI_JSON = {
  headline: '订单服务引入服务层并扩展状态机', risk: 'medium',
  architecture: {
    layers: [
      { id: 'ui', name: '表现层', components: [{ id: 'ui', name: '订单页面', status: 'modified', modules: ['src/ui/OrderPage.tsx'] }] },
      { id: 'api', name: '接口层', components: [{ id: 'api', name: '订单 API', status: 'modified', modules: ['src/api/orders.ts'] }] },
      { id: 'svc', name: '业务层', components: [{ id: 'svc', name: '订单服务', status: 'added', modules: ['src/services/orderService.ts'], note: '新增服务层' }] },
      { id: 'data', name: '数据层', components: [{ id: 'repo', name: '订单仓储', status: 'removed' }, { id: 'reader', name: '读仓储', status: 'added' }, { id: 'writer', name: '写仓储', status: 'added' }] }
    ],
    links: [{ from: 'ui', to: 'api', status: 'unchanged' }, { from: 'api', to: 'repo', status: 'removed' }, { from: 'api', to: 'svc', status: 'added' }, { from: 'svc', to: 'reader', status: 'added' }, { from: 'svc', to: 'writer', status: 'added' }]
  },
  sequences: [{ id: 'pay', title: '支付订单', before: { participants: [{ id: 'u', name: '用户', kind: 'actor' }, { id: 'api', name: 'orders API' }, { id: 'repo', name: 'orderRepo' }], steps: [{ type: 'msg', from: 'u', to: 'api', label: 'payOrder(id)' }, { type: 'msg', from: 'api', to: 'repo', label: 'saveOrder(o)' }] },
    after: { participants: [{ id: 'u', name: '用户', kind: 'actor' }, { id: 'api', name: 'orders API' }, { id: 'svc', name: 'OrderService' }, { id: 'w', name: 'orderWriter' }], steps: [{ type: 'msg', from: 'u', to: 'api', label: 'payOrder(id)' }, { type: 'msg', from: 'api', to: 'svc', label: 'pay(id)' }, { type: 'alt', label: '状态校验', branches: [{ label: '可支付', steps: [{ type: 'msg', from: 'svc', to: 'w', label: 'saveOrder(o)' }] }] }] } }],
  states: [{ id: 'order', name: '订单生命周期', before: { initial: 'new', states: [{ id: 'new' }, { id: 'paid' }, { id: 'shipped' }], transitions: [{ from: 'new', to: 'paid', event: 'pay' }, { from: 'paid', to: 'shipped', event: 'ship' }] },
    after: { initial: 'new', states: [{ id: 'new' }, { id: 'paid' }, { id: 'shipped' }, { id: 'cancelled' }, { id: 'refunded' }], transitions: [{ from: 'new', to: 'paid', event: 'pay' }, { from: 'paid', to: 'shipped', event: 'ship' }, { from: 'new', to: 'cancelled', event: 'cancel' }, { from: 'paid', to: 'refunded', event: 'refund' }] } }],
  flows: [{ id: 'checkout', title: '下单到发货', before: { nodes: [{ id: 's', label: '用户下单', kind: 'start' }, { id: 'p', label: '支付' }, { id: 'sh', label: '发货' }, { id: 'e', label: '完成', kind: 'end' }], edges: [{ from: 's', to: 'p' }, { from: 'p', to: 'sh' }, { from: 'sh', to: 'e' }] },
    after: { nodes: [{ id: 's', label: '用户下单', kind: 'start' }, { id: 'd', label: '是否取消?', kind: 'decision' }, { id: 'c', label: '取消订单' }, { id: 'p', label: '支付' }, { id: 'sh', label: '发货' }, { id: 'e', label: '完成', kind: 'end' }], edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'c', label: '是' }, { from: 'd', to: 'p', label: '否' }, { from: 'p', to: 'sh' }, { from: 'sh', to: 'e' }, { from: 'c', to: 'e' }] } }]
}
