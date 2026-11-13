// 统计 hclyz 直播流真实可用率、失败原因、CDN 主机分布
const MF = "http://api.hclyz.com:81/mf";
const PROBE_BYTES = 16 * 1024;
const TIMEOUT = 9000;

async function getHosts(platform) {
  const res = await fetch(`${MF}/${platform}`, { signal: AbortSignal.timeout(20000) });
  const j = JSON.parse(await res.text());
  return (j.zhubo || []).map((x) => ({ title: x.title, address: x.address }));
}

async function probeStream(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* Stream may already be closed after the bounded probe. */ }
      return { ok: false, ms: Date.now() - t0, err: `HTTP ${res.status}` };
    }
    const reader = res.body.getReader();
    let got = 0;
    while (got < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value?.length || 0;
    }
    try { await reader.cancel(); } catch { /* Stream may already be closed after the bounded probe. */ }
    return got > 0
      ? { ok: true, ms: Date.now() - t0, got }
      : { ok: false, ms: Date.now() - t0, err: "empty body" };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: `${e.name}${e.cause?.code ? "/" + e.cause.code : ""}` };
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    })
  );
  return out;
}

async function main() {
  const platform = process.argv[2] || "jsonkawayi.txt";
  const hosts = await getHosts(platform);
  console.log(`平台 ${platform}：${hosts.length} 个频道`);

  const byHost = {};
  for (const h of hosts) {
    const host = (h.address.match(/^https?:\/\/([^/]+)/) || [])[1] || "?";
    byHost[host] = (byHost[host] || 0) + 1;
  }
  const top = Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("\n=== CDN 主机分布（Top8）===");
  for (const [h, n] of top) console.log(`  ${n.toString().padStart(3)}  ${h}`);
  console.log(`  唯一主机数: ${Object.keys(byHost).length}`);

  console.log("\n=== 全量探测（并发 6）===");
  const res = await pool(hosts, 6, async (h) => ({ ...h, ...(await probeStream(h.address)) }));
  const ok = res.filter((r) => r.ok);
  const bad = res.filter((r) => !r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`  可用 ${ok.length}/${res.length} (${((ok.length / res.length) * 100).toFixed(1)}%)`);
  console.log(`  延迟 P50=${lat[Math.floor(lat.length * 0.5)]}ms P90=${lat[Math.floor(lat.length * 0.9)]}ms max=${lat[lat.length - 1]}ms`);
  const byErr = {};
  for (const b of bad) byErr[b.err] = (byErr[b.err] || 0) + 1;
  console.log("  失败原因:", byErr);

  if (bad.length > 0) {
    console.log("\n=== 失败样本（前 8）===");
    for (const b of bad.slice(0, 8)) console.log(`  [${b.err}] ${b.title} ${b.address.slice(0, 70)}`);
    console.log("\n=== 失败项 5s 后重试一次（区分瞬时抖动 vs 真死）===");
    await new Promise((r) => setTimeout(r, 5000));
    const retry = await pool(bad, 3, async (h) => ({ ...h, ...(await probeStream(h.address)) }));
    const recovered = retry.filter((r) => r.ok);
    console.log(`  重试恢复 ${recovered.length}/${retry.length}`);
    for (const r of recovered.slice(0, 5)) console.log(`    恢复: ${r.title}`);
  }
}

main().catch((e) => console.error("FATAL", e));
