// AI provider presets for GitLoom 0.4.2.
//
// Every base URL and auth scheme below was checked against the provider's official documentation
// on 2026-10-19 (sources listed per preset in `source`). Model lists are only *suggestions* used as a
// fallback when the provider's /models endpoint is unavailable — the live list always wins.
//
// Protocols:
//   openai    — POST {baseUrl}/chat/completions, `Authorization: Bearer <key>`, SSE `data:` chunks with choices[0].delta.content
//   anthropic — POST {baseUrl}/v1/messages, `x-api-key` + `anthropic-version: 2023-06-01`, SSE content_block_delta events
//   azure     — POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…, `api-key` header

export type AIProtocol = 'openai' | 'anthropic' | 'azure'
export type AIProviderGroup = 'intl' | 'cn' | 'agg'

export interface AIProviderPreset {
  id: string
  name: string
  group: AIProviderGroup
  /** 1–2 letter badge + colour shown in the picker */
  initials: string
  color: string
  protocol: AIProtocol
  baseUrl: string
  /** alternative regional endpoints (same protocol) */
  regions?: { label: string; baseUrl: string }[]
  models: string[]
  /** where to create an API key */
  keyUrl?: string
  /** official doc the base URL/auth were verified against */
  source: string
  /** key not required (local servers) */
  keyOptional?: boolean
  /** GET {base}/models is supported */
  listModels: boolean
  /** extra static headers */
  headers?: Record<string, string>
  /** one-line hint shown under the picker */
  note?: string
  /** search keywords */
  kw?: string
}

export const AI_GROUPS: { id: AIProviderGroup; label: string }[] = [
  { id: 'intl', label: '国际' },
  { id: 'cn', label: '国内' },
  { id: 'agg', label: '聚合与本地' }
]

export const AI_PRESETS: AIProviderPreset[] = [
  // ------------------------------------------------------------------ 国际
  {
    id: 'openai', name: 'OpenAI', group: 'intl', initials: 'AI', color: '#10a37f', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna'],
    keyUrl: 'https://platform.openai.com/api-keys', listModels: true,
    source: 'https://developers.openai.com/api/docs/models · https://platform.openai.com/docs/api-reference/introduction (Bearer auth)', kw: 'gpt chatgpt'
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', group: 'intl', initials: 'C', color: '#d97757', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys', listModels: true,
    source: 'https://docs.anthropic.com/en/api/messages (POST /v1/messages, x-api-key, anthropic-version) · https://platform.claude.com/docs/en/api/versioning (2023-06-01) · GET /v1/models',
    note: '原生 Messages API（x-api-key + anthropic-version），新模型不支持自定义温度，GitLoom 会自动省略。', kw: 'claude'
  },
  {
    id: 'gemini', name: 'Google Gemini', group: 'intl', initials: 'G', color: '#4285f4', protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey', listModels: true,
    source: 'https://ai.google.dev/gemini-api/docs/openai (OpenAI compatibility, Bearer GEMINI_API_KEY, /models)', note: '使用 Gemini 官方 OpenAI 兼容端点。', kw: 'google bard'
  },
  {
    id: 'xai', name: 'xAI Grok', group: 'intl', initials: 'X', color: '#111111', protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1', models: ['grok-4.7', 'grok-4.20', 'grok-4.20-0309-non-reasoning'],
    keyUrl: 'https://console.x.ai', listModels: true,
    source: 'https://docs.x.ai/docs/api-reference (base_url https://api.x.ai/v1, Bearer XAI_API_KEY)', kw: 'grok'
  },
  {
    id: 'mistral', name: 'Mistral', group: 'intl', initials: 'M', color: '#fa520f', protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys', listModels: true,
    source: 'https://docs.mistral.ai/api/ (POST https://api.mistral.ai/v1/chat/completions, Bearer)', kw: 'codestral'
  },
  {
    id: 'groq', name: 'Groq', group: 'intl', initials: 'GQ', color: '#f55036', protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
    keyUrl: 'https://console.groq.com/keys', listModels: true,
    source: 'https://console.groq.com/docs/openai (base_url https://api.groq.com/openai/v1) · https://console.groq.com/docs/models', kw: 'llama'
  },
  {
    id: 'azure', name: 'Azure OpenAI', group: 'intl', initials: 'Az', color: '#0078d4', protocol: 'azure',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com', models: [],
    keyUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI', listModels: false,
    source: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference (POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21, api-key header)',
    note: '填写资源 Endpoint、部署名（deployment）与 api-version；模型由部署决定。', kw: 'microsoft'
  },
  // ------------------------------------------------------------------ 国内
  {
    id: 'deepseek', name: 'DeepSeek 深度求索', group: 'cn', initials: 'DS', color: '#4d6bfe', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys', listModels: true,
    source: 'https://api-docs.deepseek.com/ (base_url https://api.deepseek.com, POST /chat/completions, Bearer)', kw: 'shendu'
  },
  {
    id: 'dashscope', name: '通义千问 · 阿里云百炼', group: 'cn', initials: '通', color: '#615ced', protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    regions: [
      { label: '华北2（北京）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { label: '新加坡', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { label: '美国（弗吉尼亚）', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
      { label: '中国香港', baseUrl: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1' }
    ],
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.5-flash', 'qwen-plus', 'qwen-max'],
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', listModels: true,
    source: 'https://help.aliyun.com/zh/model-studio/base-url (compatible-mode/v1 per region) · https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    note: 'API Key 按地域绑定：北京的 Key 只能用北京地址，否则返回 401。', kw: 'qwen tongyi bailian aliyun alibaba'
  },
  {
    id: 'zhipu', name: '智谱 GLM', group: 'cn', initials: '智', color: '#3859ff', protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', listModels: false,
    source: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction (base_url https://open.bigmodel.cn/api/paas/v4/)', kw: 'zhipu glm chatglm bigmodel'
  },
  {
    id: 'moonshot', name: 'Moonshot Kimi', group: 'cn', initials: 'K', color: '#1a1a1a', protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2.6', 'kimi-k2.7-code'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys', listModels: true,
    source: 'https://platform.moonshot.cn/docs/api/chat (https://api.moonshot.cn/v1/chat/completions, Bearer)', kw: 'kimi yuezhianmian'
  },
  {
    id: 'ark', name: '豆包 · 火山方舟', group: 'cn', initials: '豆', color: '#3370ff', protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-2-1-pro-260915', 'doubao-seed-1-8-251228'],
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', listModels: false,
    source: 'https://ark.volcengine.com/region:cn-beijing/docs/base-url-and-authentication (数据面 https://ark.cn-beijing.volces.com/api/v3, Authorization: Bearer $ARK_API_KEY)',
    note: '模型 ID 以控制台「开通管理」中的 Model ID（或推理接入点 ep-…）为准。', kw: 'doubao volcengine bytedance'
  },
  {
    id: 'qianfan', name: '百度千帆', group: 'cn', initials: '千', color: '#2468f2', protocol: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2', models: ['ernie-4.5-turbo-128k', 'ernie-4.5-8k-preview', 'ernie-3.5-8k', 'deepseek-v3'],
    keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list', listModels: false,
    source: 'https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26 (OpenAI 兼容 base_url https://qianfan.baidubce.com/v2) · https://cloud.baidu.com/doc/qianfan-api/s/ym9chdsy5 (Bearer bce-v3/…)', kw: 'ernie wenxin baidu'
  },
  {
    id: 'hunyuan', name: '腾讯混元', group: 'cn', initials: '混', color: '#0052d9', protocol: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    regions: [
      { label: '混元 OpenAI 兼容', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
      { label: 'TokenHub 广州', baseUrl: 'https://tokenhub.tencentmaas.com/v1' },
      { label: 'TokenHub 新加坡', baseUrl: 'https://tokenhub-intl.tencentmaas.com/v1' }
    ],
    models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest', 'hunyuan-lite'],
    keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key', listModels: false,
    source: 'https://cloud.tencent.com/document/product/1729/111007 (base_url https://api.hunyuan.cloud.tencent.com/v1, Bearer) · https://cloud.tencent.com/document/product/1823/130079 (TokenHub)',
    note: '腾讯官方提示混元正逐步迁移到 TokenHub，新开通可选 TokenHub 地址。', kw: 'tencent hunyuan tokenhub'
  },
  {
    id: 'minimax', name: 'MiniMax', group: 'cn', initials: 'MM', color: '#e2167e', protocol: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',
    regions: [
      { label: '中国大陆', baseUrl: 'https://api.minimax.cn/v1' },
      { label: '国际站', baseUrl: 'https://api.minimax.io/v1' }
    ],
    models: ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview', 'MiniMax-M2.7'],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', listModels: true,
    source: 'https://platform.minimaxi.com/docs/guides/text-generation (OpenAI 兼容 base_url https://api.minimax.cn/v1, Bearer) · https://platform.minimaxi.com/docs/api-reference/text-openai-api', kw: 'minimax hailuo'
  },
  {
    id: 'spark', name: '讯飞星火', group: 'cn', initials: '星', color: '#1677ff', protocol: 'openai',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1', models: ['4.0Ultra', 'generalv3.5', 'max-32k', 'pro-128k', 'lite'],
    keyUrl: 'https://console.xfyun.cn/services/bm4', listModels: false,
    source: 'https://www.xfyun.cn/doc/spark/HTTP调用文档.html (POST https://spark-api-open.xf-yun.com/v1/chat/completions, Authorization: Bearer <APIPassword>)',
    note: 'Key 填控制台「http 服务接口认证信息」里的 APIPassword（各版本不同）。', kw: 'xunfei spark iflytek'
  },
  {
    id: 'yi', name: '零一万物', group: 'cn', initials: '01', color: '#133426', protocol: 'openai',
    baseUrl: 'https://api.lingyiwanwu.com/v1', models: ['yi-lightning', 'yi-medium', 'yi-vision-v2'],
    keyUrl: 'https://platform.lingyiwanwu.com/apikeys', listModels: true,
    source: 'https://platform.lingyiwanwu.com/docs (https://api.lingyiwanwu.com/v1/chat/completions, Bearer)', kw: 'yi lingyi 01ai'
  },
  // ------------------------------------------------------------------ 聚合与本地
  {
    id: 'openrouter', name: 'OpenRouter', group: 'agg', initials: 'OR', color: '#6467f2', protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/auto', 'anthropic/claude-sonnet-5-5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro'],
    keyUrl: 'https://openrouter.ai/settings/keys', listModels: true,
    headers: { 'HTTP-Referer': 'https://github.com/gitloom/gitloom', 'X-Title': 'GitLoom' },
    source: 'https://openrouter.ai/docs/api/reference/overview (https://openrouter.ai/api/v1/chat/completions, Bearer, optional HTTP-Referer / X-Title attribution headers)', kw: 'router aggregator'
  },
  {
    id: 'siliconflow', name: '硅基流动 SiliconFlow', group: 'agg', initials: '硅', color: '#7c3aed', protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    regions: [{ label: '国内站', baseUrl: 'https://api.siliconflow.cn/v1' }, { label: '国际站', baseUrl: 'https://api.siliconflow.com/v1' }],
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4', 'zai-org/GLM-5.2', 'moonshotai/Kimi-K2.7-Code'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak', listModels: true,
    source: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions (https://api.siliconflow.cn/v1/chat/completions, Bearer)', kw: 'siliconflow guiji'
  },
  {
    id: 'oneapi', name: 'one-api / new-api 中转', group: 'agg', initials: '1A', color: '#0ea5e9', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:3000/v1', models: [], listModels: true,
    source: 'one-api / new-api expose the OpenAI schema at {your-host}/v1 with `Authorization: Bearer sk-…` tokens (README of songquanpeng/one-api and QuantumNous/new-api)',
    note: '填写你的中转站地址（以 /v1 结尾）与令牌。', kw: 'oneapi newapi relay proxy zhongzhuan'
  },
  {
    id: 'ollama', name: 'Ollama（本地）', group: 'agg', initials: 'Ol', color: '#555555', protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1', models: ['qwen3', 'llama3.2', 'deepseek-r1', 'gemma3'], keyOptional: true, listModels: true,
    keyUrl: 'https://ollama.com/download',
    source: 'https://docs.ollama.com/api/openai-compatibility (http://localhost:11434/v1/, API key required by SDK but ignored)', note: '先运行 `ollama serve` 并 `ollama pull <模型>`；无需 Key。', kw: 'local'
  },
  {
    id: 'lmstudio', name: 'LM Studio（本地）', group: 'agg', initials: 'LM', color: '#4f46e5', protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1', models: [], keyOptional: true, listModels: true,
    keyUrl: 'https://lmstudio.ai/download',
    source: 'https://lmstudio.ai/docs/developer/openai-compat (http://localhost:1234/v1)', note: '在 LM Studio「Developer」页启动本地服务器；无需 Key。', kw: 'local'
  },
  {
    id: 'custom', name: '自定义 OpenAI 兼容', group: 'agg', initials: '⋯', color: '#64748b', protocol: 'openai',
    baseUrl: '', models: [], keyOptional: true, listModels: true,
    source: 'OpenAI Chat Completions schema: POST {base}/chat/completions with Bearer auth', note: '任何兼容 OpenAI Chat Completions 的服务（vLLM、LocalAI、本地 v0 代理等）。', kw: 'vllm localai proxy'
  }
]

export const presetById = (id: string): AIProviderPreset => AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[AI_PRESETS.length - 1]

/** Searchable text for the picker. */
export const presetMatches = (p: AIProviderPreset, q: string): boolean => {
  const s = q.trim().toLowerCase()
  if (!s) return true
  return [p.name, p.id, p.kw ?? '', p.baseUrl, ...p.models].join(' ').toLowerCase().includes(s)
}

/** Guess the preset of a legacy single-endpoint config from its base URL. */
export function presetForUrl(url: string): AIProviderPreset {
  const u = url.trim().replace(/\/+$/, '')
  if (!u) return presetById('custom')
  const host = (() => { try { return new URL(u).host } catch { return '' } })()
  const hit = AI_PRESETS.find((p) => p.id !== 'custom' && p.id !== 'oneapi' && p.baseUrl && [p.baseUrl, ...(p.regions ?? []).map((r) => r.baseUrl)].some((b) => { try { return new URL(b).host === host } catch { return false } }))
  return hit ?? presetById('custom')
}
