// 探测 hclyz 接口与直播流：并发限制 / 限速 / 防盗链 / token 过期
const MF = "http://api.hclyz.com:81/mf";

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { label, ms: Date.now() - t0, ok: true, ...r };
  } catch (e) {
    return { label, ms: Date.now() - t0, ok: false, err: `${e.name}: ${e.message}`, cause: e.cause?.code || "" };
  }
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  return { status: res.status, len: text.length, text };
}

async function main() {
  console.log("=== 1) 单次基线 ===");
  const base = await timed("GET json.txt", () => getText(`${MF}/json.txt`));
  console.log(base.ok ? `status=${base.status} len=${base.len} ${base.ms}ms` : `${base.err} ${base.ms}ms`);

  console.log("\n=== 2) 接口并发（10 路同时 GET json.txt） ===");
  const conc = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      timed(`conc#${i}`, async () => {
        const r = await getText(`${MF}/json.txt`);
        return { status: r.status, len: r.len };
      })
    )
  );
  for (const c of conc) console.log(c.ok ? `  #${c.label.split("#")[1]} status=${c.status} len=${c.len} ${c.ms}ms` : `  ${c.label} FAIL ${c.err} ${c.ms}ms`);

  console.log("\n=== 3) 快速连续 20 次（无间隔，看是否触发限速） ===");
  const seq = [];
  for (let i = 0; i < 20; i += 1) {
    seq.push(await timed(`seq#${i}`, async () => {
      const r = await getText(`${MF}/json.txt`);
      return { status: r.status, len: r.len };
    }));
  }
  const seqFail = seq.filter((s) => !s.ok || s.status !== 200);
  console.log(`  成功 ${seq.length - seqFail.length}/${seq.length}, 耗时 ${seq.reduce((a, s) => a + s.ms, 0)}ms`);
  for (const f of seqFail) console.log(`  FAIL: ${f.label} ${f.err || "status=" + f.status}`);

  console.log("\n=== 4) 平台列表/主播列表并发（混合 8 路） ===");
  const mix = await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => timed(`p#${i}`, async () => { const r = await getText(`${MF}/json.txt`); return { status: r.status, len: r.len }; })),
    ...Array.from({ length: 4 }, (_, i) => timed(`h#${i}`, async () => { const r = await getText(`${MF}/jsonkawayi.txt`); return { status: r.status, len: r.len }; })),
  ]);
  for (const m of mix) console.log(m.ok ? `  ${m.label} status=${m.status} len=${m.len} ${m.ms}ms` : `  ${m.label} FAIL ${m.err}`);

  console.log("\n=== 5) 主播流地址特征（token 是否带过期时间） ===");
  const h = await getText(`${MF}/jsonkawayi.txt`);
  const hosts = JSON.parse(h.text).zhubo || [];
  console.log(`  共 ${hosts.length} 条`);
  const sample = hosts.slice(0, 5).map((x) => x.address);
  for (const s of sample) console.log("   ", s);
  const withTime = hosts.filter((x) => /wsTime|wsSecret|expire|exp=|token=/i.test(x.address)).length;
  const proto = hosts.reduce((acc, x) => { const p = (x.address.match(/^(\w+):/) || [])[1] || "?"; acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  const ext = hosts.reduce((acc, x) => { const m = (x.address.match(/\.(flv|m3u8|mp4|ts)(\?|$)/i) || [])[1] || "other"; acc[m] = (acc[m] || 0) + 1; return acc; }, {});
  console.log(`  带 token/过期参数: ${withTime}/${hosts.length}`);
  console.log("  协议分布:", proto);
  console.log("  后缀分布:", ext);

  console.log("\n=== 6) 直连 3 个流：GET 前 64KB，看是否可读/是否 403 ===");
  for (const url of sample.slice(0, 3)) {
    const r = await timed("stream", async () => {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "*/*" },
        signal: AbortSignal.timeout(15000),
      });
      const reader = res.body?.getReader();
      let got = 0;
      if (reader) {
        while (got < 65536) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value?.length || 0;
        }
        try { await reader.cancel(); } catch {}
      }
      return { status: res.status, ctype: res.headers.get("content-type"), got };
    });
    console.log(r.ok ? `  ${r.status} ctype=${r.ctype} 读到 ${r.got}B ${r.ms}ms` : `  FAIL ${r.err} ${r.ms}ms`);
    console.log(`    ${url.slice(0, 90)}`);
  }

  console.log("\n=== 7) 同一流并发 5 路（模拟「全部预览」并发拉流） ===");
  const one = sample[0];
  const par = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      timed(`s#${i}`, async () => {
        const res = await fetch(one, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
        const reader = res.body?.getReader();
        let got = 0;
        if (reader) {
          while (got < 32768) {
            const { done, value } = await reader.read();
            if (done) break;
            got += value?.length || 0;
          }
          try { await reader.cancel(); } catch {}
        }
        return { status: res.status, got };
      })
    )
  );
  for (const p of par) console.log(p.ok ? `  #${p.label.split("#")[1]} status=${p.status} ${p.got}B ${p.ms}ms` : `  ${p.label} FAIL ${p.err} ${p.ms}ms`);
}

main().catch((e) => console.error("FATAL", e));
