import {withSourceContext} from '../src/sources/request-context.mjs';
// 全网搜索适配器测试（Tavily / 博查 / Serper）
//
// 这个模块此前零测试，而且它是唯一一个「用户自己配 Key 才能用」的源 ——
// 配错了没人会告诉你为什么没数据。这里用 mock fetch 把三家返回结构都验一遍，
// 保证「配了 Key 就能出结果」这件事是可验证的。
import {
  searchQuery as rawSearchQuery,
  searchAll as rawSearchAll,
  siteLabel,
  providerLabel,
  normalizeWebResult,
  meta,
} from '../src/sources/searchapi.mjs';

const fakeRequest=async(url,opts)=>{const r=await globalThis.fetch(url,opts);return {status:r.status,headers:{},text:await r.text(),url:String(url)};};
const searchQuery=(...args)=>withSourceContext({request:fakeRequest},()=>rawSearchQuery(...args));
const searchAll=(...args)=>withSourceContext({request:fakeRequest},()=>rawSearchAll(...args));
let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`);
  }
};

/* ---------- mock fetch ---------- */
const realFetch = globalThis.fetch;
let lastRequest = null;
function mockFetch(handler) {
  globalThis.fetch = async (url, opts = {}) => {
    lastRequest = { url: String(url), opts };
    const r = handler(String(url), opts);
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}
function restore() {
  globalThis.fetch = realFetch;
}

console.log('\n[1] 基础元信息');
ok('meta.id = web', meta.id === 'web');
ok('providerLabel 认识三家', ['tavily', 'bocha', 'serper'].every((p) => providerLabel(p) && providerLabel(p) !== p));
ok('providerLabel 未知通道原样返回', providerLabel('nope') === 'nope');

console.log('\n[2] siteLabel：把域名翻译成人看得懂的站名');
ok('BOSS直聘', siteLabel('https://www.zhipin.com/job_detail/xxx.html') === 'BOSS直聘');
ok('实习僧', siteLabel('https://www.shixiseng.com/intern/123') === '实习僧');
ok('应届生', siteLabel('https://q.yingjiesheng.com/x') === '应届生求职网');
ok('未知域名回退为域名本身', siteLabel('https://example.edu.cn/a') === 'example.edu.cn');
ok('非法 URL 不抛异常', siteLabel('not-a-url') === '');

console.log('\n[3] normalizeWebResult：统一结构 + 过滤无效项');
{
  const r = normalizeWebResult({ title: '某公司2027届校招', url: 'https://www.zhipin.com/x', snippet: '招聘消防工程师', date: '2026-09-01' }, 'tavily');
  ok('产出岗位对象', Boolean(r));
  ok('id 带 web: 前缀', r.id.startsWith('web:'));
  ok('source = web', r.source === 'web');
  ok('sourceName 含引擎与站点', /Tavily/.test(r.sourceName) && /BOSS直聘/.test(r.sourceName), r.sourceName);
  ok('标记为网页线索 isWebLead', r.isWebLead === true);
  ok('日期被规范化', /2026-09-01/.test(r.publishTime), r.publishTime);
  ok('无 url 的结果被丢弃', normalizeWebResult({ title: 'X' }, 'tavily') === null);
  ok('无标题无摘要的被丢弃', normalizeWebResult({ url: 'https://a.com' }, 'tavily') === null);
  ok('只有摘要时用摘要当标题', normalizeWebResult({ url: 'https://a.com', snippet: '只有摘要内容' }, 'tavily')?.title === '只有摘要内容');
  ok('null 输入不抛异常', normalizeWebResult(null, 'tavily') === null);
}

console.log('\n[4] Tavily 响应结构');
{
  mockFetch(() => ({
    body: {
      results: [
        { title: '消防工程师招聘', url: 'https://jobs.example.com/1', content: '负责消防设施维护', score: 0.92, published_date: '2026-09-05' },
        { title: '安全工程师', url: 'https://jobs.example.com/2', content: '安全管理', score: 0.8 },
      ],
    },
  }));
  const r = await searchQuery('消防工程师 2027届', { provider: 'tavily', apiKey: 'tvly-test' });
  ok('解析出 2 条', r.length === 2, String(r.length));
  ok('标题正确', r[0].title === '消防工程师招聘');
  ok('摘要来自 content', /消防设施维护/.test(r[0].summary));
  ok('engineScore 保留', r[0].extra.engineScore === 0.92);
  ok('请求发到 Tavily 端点', /api\.tavily\.com/.test(lastRequest.url));
  ok('用 Bearer 认证', /Bearer tvly-test/.test(JSON.stringify(lastRequest.opts.headers)));
  restore();
}

console.log('\n[5] 博查响应结构（嵌套 data.webPages.value）');
{
  mockFetch(() => ({
    body: {
      code: 200,
      data: {
        webPages: {
          value: [{ name: '机场消防岗', url: 'https://a.com/x', summary: '机场消防', datePublished: '2026-08-20' }],
        },
      },
    },
  }));
  const r = await searchQuery('机场消防', { provider: 'bocha', apiKey: 'bsa-test' });
  ok('解析出 1 条', r.length === 1, String(r.length));
  ok('标题来自 name 字段', r[0].title === '机场消防岗', r[0].title);
  ok('摘要来自 summary 字段', /机场消防/.test(r[0].summary));
  restore();
}

console.log('\n[6] Serper 响应结构（organic）');
{
  mockFetch(() => ({
    body: { organic: [{ title: '校招公告', link: 'https://b.com/y', snippet: '2027届校园招聘', date: '2026-09-10' }] },
  }));
  const r = await searchQuery('2027届 校招', { provider: 'serper', apiKey: 'serper-test' });
  ok('解析出 1 条', r.length === 1, String(r.length));
  ok('url 来自 link 字段', r[0].url === 'https://b.com/y', r[0].url);
  ok('用 X-API-KEY 认证', lastRequest.opts.headers['X-API-KEY'] === 'serper-test');
  restore();
}

console.log('\n[7] 错误处理');
{
  try {
    await searchQuery('x', { provider: 'unknown', apiKey: 'k' });
    ok('未知通道应抛错', false);
  } catch (e) {
    ok('未知通道抛出明确错误', /未知搜索通道/.test(e.message), e.message);
  }
  try {
    await searchQuery('x', { provider: 'tavily', apiKey: '' });
    ok('缺 Key 应抛错', false);
  } catch (e) {
    ok('缺 Key 抛出明确错误', /缺少 API Key/.test(e.message), e.message);
  }
  // HTTP 错误要被包装成可读信息，而不是静默返回空
  mockFetch(() => ({ status: 401, body: { error: 'invalid api key' } }));
  try {
    await searchQuery('x', { provider: 'tavily', apiKey: 'bad' });
    ok('HTTP 401 应抛错', false);
  } catch (e) {
    ok('HTTP 错误带状态码', /401/.test(e.message), e.message);
  }
  restore();
  // 博查特有的业务错误码
  mockFetch(() => ({ body: { code: 403, msg: '余额不足' } }));
  try {
    await searchQuery('x', { provider: 'bocha', apiKey: 'k' });
    ok('博查业务错误码应抛错', false);
  } catch (e) {
    ok('博查业务错误码被识别', /403|余额不足/.test(e.message), e.message);
  }
  restore();
}

console.log('\n[8] searchAll：多查询聚合 + 单条失败不影响其他');
{
  let n = 0;
  mockFetch(() => {
    n++;
    if (n === 2) return { status: 500, body: { err: 'boom' } };
    return { body: { results: [{ title: `结果${n}`, url: `https://a.com/${n}`, content: 'x' }] } };
  });
  const logs = [];
  const r = await searchAll(['q1', 'q2', 'q3'], { provider: 'tavily', apiKey: 'k', log: (m) => logs.push(m) });
  ok('成功的查询产出岗位', r.jobs.length === 2, String(r.jobs.length));
  ok('失败的查询记入 errors', r.errors.length === 1, JSON.stringify(r.errors));
  ok('失败信息含查询词', /q2/.test(r.errors[0]), r.errors[0]);
  ok('有日志输出', logs.length >= 3, String(logs.length));
  restore();
}

console.log('\n[9] 中止信号');
{
  mockFetch(() => ({ body: { results: [{ title: 'X', url: 'https://a.com/1', content: 'x' }] } }));
  const ac = new AbortController();
  ac.abort();
  const r = await searchAll(['q1', 'q2'], { provider: 'tavily', apiKey: 'k', signal: ac.signal });
  ok('已中止时不发起查询', r.jobs.length === 0 && r.errors.length === 0, `jobs=${r.jobs.length}`);
  restore();
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
