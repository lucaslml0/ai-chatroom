// ai-chatroom 文件存储测试（不调真实后端，只验纯函数 + S3 SigV4 签名结构）。
// Usage: node test_storage.mjs
import {
  sanitizeAttachments, sanitizeStorageConfig, storageKeyFor,
  isBlockedFile, isInlineMime, fileExt, formatFileName, s3Fetch, webdavFetch,
} from "./src/index.js";

let passed = [];
let failed = [];
function check(name, cond, extra = "") {
  (cond ? passed : failed).push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${cond ? "" : extra}`);
}

// ---------- 纯函数 ----------
check("attachments：正常数组保留", JSON.stringify(sanitizeAttachments([{ id: "f_1", name: "a.png", mime: "image/png", size: 123 }])) === JSON.stringify([{ id: "f_1", name: "a.png", mime: "image/png", size: 123 }]));
check("attachments：超 5 个只留 5 个", sanitizeAttachments([1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: "f_" + i, name: "a", mime: "text/plain", size: 1 }))).length === 5);
check("attachments：缺 id/name 的丢掉", sanitizeAttachments([{ id: "", name: "a", mime: "x", size: 1 }, { id: "f_1", name: "", mime: "x", size: 1 }, { id: "f_2", name: "b", mime: "x", size: 2 }]).length === 1);
check("attachments：非数组返回 []", sanitizeAttachments("nope").length === 0 && sanitizeAttachments(null).length === 0);
check("attachments：名字截断 200 字", sanitizeAttachments([{ id: "f_1", name: "x".repeat(300), mime: "x", size: 1 }])[0].name.length === 200);
check("storageConfig：默认 provider none", sanitizeStorageConfig({}).provider === "none" && sanitizeStorageConfig({}).max_file_mb === 10);
check("storageConfig：非法 provider 回落 none", sanitizeStorageConfig({ provider: "ftp" }).provider === "none");
check("storageConfig：max_file_mb 夹在 1–50", sanitizeStorageConfig({ max_file_mb: 0 }).max_file_mb === 1 && sanitizeStorageConfig({ max_file_mb: 999 }).max_file_mb === 50);
check("storageConfig：S3 字段保留", sanitizeStorageConfig({ provider: "s3", s3: { endpoint: "https://s3.example.com", region: "us-west-2", bucket: "b", access_key_id: "AK", secret_access_key: "SK" } }).s3.bucket === "b");
check("storageConfig：WebDAV URL 去掉尾部斜杠", sanitizeStorageConfig({ webdav: { url: "https://dav.example.com/chatroom///" } }).webdav.url === "https://dav.example.com/chatroom");
check("storageKeyFor：R2/S3 带 chatroom/ 前缀", storageKeyFor("r2", "f_abc") === "chatroom/f_abc" && storageKeyFor("s3", "f_abc") === "chatroom/f_abc");
check("storageKeyFor：WebDAV 平铺", storageKeyFor("webdav", "f_abc") === "f_abc");
check("fileExt：取后缀小写", fileExt("Photo.PNG") === "png" && fileExt("noext") === "" && fileExt("a.tar.gz") === "gz");
check("isBlockedFile：exe/js/html 拦截", isBlockedFile("a.exe") && isBlockedFile("a.JS") && isBlockedFile("a.html") && !isBlockedFile("a.png") && !isBlockedFile("a.pdf"));
check("isInlineMime：图片/视频/音频 inline", isInlineMime("image/png") && isInlineMime("video/mp4") && isInlineMime("audio/mpeg"));
check("isInlineMime：svg 不 inline（防脚本）", !isInlineMime("image/svg+xml") && !isInlineMime("application/pdf"));
check("formatFileName：去掉路径分隔符", formatFileName("../../etc/passwd") === ".._.._etc_passwd" && formatFileName("a:b?c") === "a_b_c");

// ---------- WebDAV：mock fetch，抓 URL 与 Authorization 头 ----------
let davCaptured = null;
globalThis.fetch = async (url, init) => {
  davCaptured = { url, method: init && init.method, headers: init && init.headers };
  return new Response("ok", { status: 200 });
};
const davCfg = { provider: "webdav", webdav: { url: "https://dav.example.com/chatroom", username: "alice", password: "s3cret" } };
await webdavFetch(davCfg, "PUT", "f_abc123", new TextEncoder().encode("x"), "text/plain");
check("webdav：PUT 到 base URL + 文件 id", davCaptured && davCaptured.url === "https://dav.example.com/chatroom/f_abc123", davCaptured ? davCaptured.url : "no capture");
check("webdav：Basic Auth 是 base64(用户名:密码)", davCaptured && davCaptured.headers.Authorization === "Basic " + Buffer.from("alice:s3cret").toString("base64"), davCaptured ? davCaptured.headers.Authorization : "no auth");
check("webdav：带 content-type", davCaptured && davCaptured.headers["content-type"] === "text/plain");
await webdavFetch(davCfg, "GET", "f_abc123");
check("webdav：GET 同一个 URL", davCaptured && davCaptured.url === "https://dav.example.com/chatroom/f_abc123" && davCaptured.method === "GET");
const davCfgNoAuth = { provider: "webdav", webdav: { url: "https://dav.example.com/pub", username: "", password: "" } };
await webdavFetch(davCfgNoAuth, "GET", "f_x");
check("webdav：无用户名时不带 Authorization", davCaptured && !davCaptured.headers.Authorization);

// ---------- S3 path-style：mock fetch，抓 URL ----------
// 用 AWS 文档的示例凭证（AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY），
// 固定时间 2013-05-24T00:00:00Z。签名对不对由 Python 参考实现交叉核对。
const RealDate = Date;
const fixedDate = new RealDate("2013-05-24T00:00:00.000Z");
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...args); if (args.length === 0) return fixedDate; }
  static now() { return fixedDate.getTime(); }
};
let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url, method: init && init.method, headers: init && init.headers, body: init && init.body };
  return new Response("ok", { status: 200 });
};
const cfg = {
  provider: "s3",
  s3: {
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    bucket: "mybucket",
    access_key_id: "AKIDEXAMPLE",
    secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    force_path_style: false,
  },
};
const body = new TextEncoder().encode("hello");
await s3Fetch(cfg, "PUT", "chatroom/f_test123", body, "text/plain");
globalThis.Date = RealDate;
check("s3Fetch：发到虚拟主机式 URL", captured && captured.url === "https://mybucket.s3.us-east-1.amazonaws.com/chatroom/f_test123", captured ? captured.url : "no capture");
check("s3Fetch：方法是 PUT", captured && captured.method === "PUT");
const auth = captured && captured.headers && captured.headers.Authorization;
check("s3Fetch：Authorization 是 SigV4 格式", typeof auth === "string" && auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature="), auth || "no auth");
const sig = auth ? auth.split("Signature=")[1] : "";
check("s3Fetch：签名是 64 位十六进制", /^[0-9a-f]{64}$/.test(sig || ""), sig);
check("s3Fetch：x-amz-date 是固定时间", captured && captured.headers["x-amz-date"] === "20130524T000000Z", captured ? captured.headers["x-amz-date"] : "no date");
// 把签名打印出来，供 Python 参考实现核对
console.log("SIGNATURE=" + sig);
console.log("AMZ_DATE=" + (captured && captured.headers["x-amz-date"]));
console.log("PAYLOAD_HASH=" + (captured && captured.headers["x-amz-content-sha256"]));

console.log(`\n通过 ${passed.length} 项，失败 ${failed.length} 项：${failed.join("；") || "无"}`);
if (failed.length) process.exit(1);
