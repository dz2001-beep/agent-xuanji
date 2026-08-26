/**
 * web.search tests — Bing result parsing (pure function, offline fixture)
 * and tool registration.
 */

import { describe, expect, it } from 'vitest';
import { parseBingResults, registerBuiltinTools } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/tool.js';

const FIXTURE = `
<html><body>
<ul id="b_results">
  <li class="b_algo">
    <h2><a href="https://example.com/1">首个结果标题 <strong>关键词</strong></a></h2>
    <div class="b_caption"><p>这是第一个结果的摘要 &amp; 说明。</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.com/2">Second Result</a></h2>
    <div class="b_caption"><p>Second snippet here.</p></div>
  </li>
</ul>
</body></html>
`;

describe('parseBingResults', () => {
  it('extracts title, url and snippet from b_algo blocks', () => {
    const results = parseBingResults(FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: '首个结果标题 关键词',
      url: 'https://example.com/1',
      snippet: '这是第一个结果的摘要 & 说明。',
    });
    expect(results[1]?.title).toBe('Second Result');
  });

  it('respects the max limit and skips non-http links', () => {
    const html = FIXTURE + `
  <li class="b_algo"><h2><a href="/relative">相对链接</a></h2><p>忽略</p></li>
`;
    expect(parseBingResults(html, 1)).toHaveLength(1);
    const all = parseBingResults(html, 10);
    expect(all.every((r) => r.url.startsWith('http'))).toBe(true);
  });

  it('returns empty for garbage html', () => {
    expect(parseBingResults('no results here')).toEqual([]);
  });
});

describe('web tool group', () => {
  it('registers web.search with the web group', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, ['web']);
    expect(registry.has('web.search')).toBe(true);
    const tool = registry.get('web.search')!;
    expect(tool.inputSchema.required).toEqual(['query']);
  });
});
