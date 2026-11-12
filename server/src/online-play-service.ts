/**
 * 在线播放（第三方聚合接口 http://api.hclyz.com:81）服务端适配。
 * 由服务端代拉取，避免浏览器跨域/混合内容问题，也便于统一做权限校验。
 *
 * 远端数据：
 *  - /mf/json.txt         -> { pingtai: [{ title, xinimg, address, Number }] }
 *  - /mf/<address>        -> { zhubo: [{ title, img, address }] }（<address> 形如 jsonkawayi.txt）
 */

const BASE = "http://api.hclyz.com:81";
const MF_BASE = `${BASE}/mf`;
const UPSTREAM_TIMEOUT_MS = 15_000;

export interface OnlinePlatform {
  title: string;
  cover: string;
  /** 该平台的子列表文件名，如 jsonkawayi.txt */
  address: string;
  count: number;
}

export interface OnlineHost {
  title: string;
  cover: string;
  /** 直播流地址，可能是 .flv / .m3u8 / 网页地址 */
  address: string;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 MailDeck/0.4", accept: "*/*" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`在线播放接口返回 HTTP ${response.status}`);
  }
  return response.text();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export async function listOnlinePlatforms(): Promise<OnlinePlatform[]> {
  const raw = await fetchText(`${MF_BASE}/json.txt`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("在线播放接口返回的不是有效 JSON");
  }
  const record = asRecord(data);
  const rows = Array.isArray(record.pingtai) ? record.pingtai : Array.isArray(data) ? data : [];
  return rows
    .map((item) => {
      const row = asRecord(item);
      const address = str(row.address);
      return {
        title: str(row.title) || address,
        cover: str(row.xinimg),
        address,
        count: Number(row.Number ?? 0) || 0
      };
    })
    .filter((item) => item.address !== "");
}

export async function listOnlineHosts(platform: string): Promise<OnlineHost[]> {
  const name = platform.trim();
  // 严格白名单，防止把任意 URL/路径拼进上游请求（SSRF）。
  if (!/^[A-Za-z0-9_-]+\.txt$/.test(name)) {
    throw new Error("平台地址不合法");
  }
  const raw = await fetchText(`${MF_BASE}/${name}`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("平台返回的不是有效 JSON");
  }
  const record = asRecord(data);
  const rows = Array.isArray(record.zhubo)
    ? record.zhubo
    : Array.isArray(record.list)
      ? record.list
      : Array.isArray(data)
        ? data
        : [];
  return rows
    .map((item) => {
      const row = asRecord(item);
      return {
        title: str(row.title) || "未命名",
        cover: str(row.img) || str(row.xinimg),
        address: str(row.address)
      };
    })
    .filter((item) => item.address !== "");
}
