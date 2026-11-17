/**
 * 调度器节拍回归：慢片后不能连续补发；speed=0 不应再叠加抖动。
 *
 * 用法：node tests/scheduler-pacing.mjs
 */
import { TaskControl } from '../src/control.ts';
import { runSchedule } from '../src/scheduler.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

function check(ok, label, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${extra ? `  ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra ? `  ${extra}` : ''}`);
  }
}

function segments(n, duration = 1) {
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    uri: `https://example.test/${i + 1}.ts`,
    duration,
    discontinuity: false,
  }));
}

async function run(client, opts, list) {
  await runSchedule(list, client, new TaskControl(), {
    speed: 1,
    jitterMs: 0,
    retries: 0,
    paceExisting: false,
    ...opts,
  }, {
    isDone: async () => false,
    save: async () => {},
    onSegment: () => {},
    onError: () => {},
  });
}

console.log('\n1. 慢片后时间轴后移');
const starts = [];
const t0 = Date.now();
const slowFirst = {
  async get(uri) {
    starts.push(Date.now() - t0);
    if (uri.endsWith('/1.ts')) await sleep(3500);
    return Buffer.alloc(10);
  },
};
await run(slowFirst, { speed: 1, jitterMs: 0 }, segments(5));
const gap = starts[2] - starts[1];
check(starts.length === 5, '5 片都有请求', starts.join(', '));
check(gap >= 500, '慢片后的第 2 片不会立即连发第 3 片', `间隔 ${gap}ms`);

console.log('\n2. speed=0 不叠加抖动');
const t1 = Date.now();
const fastStarts = [];
const fast = {
  async get() {
    fastStarts.push(Date.now() - t1);
    return Buffer.alloc(10);
  },
};
await run(fast, { speed: 0, jitterMs: 5000 }, segments(4));
const elapsed = Date.now() - t1;
check(elapsed < 800, '全速模式总耗时不受 jitter 影响', `${elapsed}ms`);

console.log(`\n${passed}/${passed + failed} 项通过`);
if (failed > 0) {
  console.log('有失败项 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
