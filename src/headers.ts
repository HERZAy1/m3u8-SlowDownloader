/**
 * 功能 B 的全部实现：一份与真实浏览器抓包一致的请求头。
 *
 * 实测结论（2026-10-28）：目标站不校验 Referer、不校验 UA、无签名。
 * 因此这一层对当前目标**没有实际防护收益**，保留只为将来平台加防护时不用重写。
 * 不要在此基础上扩展成"指纹引擎"。
 */
export const CHROME_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: '*/*',
  'Accept-Language': 'zh,zh-CN;q=0.9,en-US;q=0.8,en;q=0.7,be;q=0.6,zh-TW;q=0.5',
  Connection: 'keep-alive',
  Origin: 'https://live.edusoho.com',
  Referer: 'https://live.edusoho.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
});
