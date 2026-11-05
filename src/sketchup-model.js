// Infinite Canvas SketchUp ↔ 导演台 联动节点。
// 照原 director 插件的方式：动态 fetch 改造版导演台（单文件 bundle）的 HTML + JS，
// 改写成 srcdoc 内联 iframe，避免跨域，也无需用户单独部署导演台。
// 然后通过 WebSocket 接收 SketchUp 模型，postMessage 注入导演台为 prop。

const WS_URL = "ws://127.0.0.1:8899";
const DIRECTOR_BASE = "https://cdn.jsdelivr.net/gh/wudidekongjv/director-desk@main";

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cacheBusted(url) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

async function fetchText(url) {
    const response = await fetch(cacheBusted(url), { cache: "no-store" });
    if (!response.ok) throw new Error(`导演台资源下载失败 (${response.status})`);
    return response.text();
}

// 把导演台 JS 里的 /director/ 绝对路径改写成 CDN 地址（照 esncy 插件方式），
// 并把 window.location.origin 指向宿主 origin（srcdoc 里 origin 为 null）。
function rewriteDirectorScript(source, hostOrigin) {
    return source
        // /director/xxx → CDN 根/xxx（含字符串字面量和 import 路径）。
        .replace(/\/director\//g, `${DIRECTOR_BASE}/`)
        .replace(/window\.location\.origin/g, JSON.stringify(hostOrigin));
}

async function prepareDirectorFrame(hostOrigin) {
    const html = await fetchText(`${DIRECTOR_BASE}/index.html`);
    const scriptMatch = html.match(/<script[^>]+src=["']([^"']+)["'][^>]*>/i);
    const styleMatch = html.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
    if (!scriptMatch) throw new Error("导演台页面缺少脚本入口");

    // 把 /director/xxx 映射到 CDN 根/xxx（去掉 /director 前缀）。
    const toCdn = (p) => {
        const clean = p.replace(/^\/director\//, "").replace(/^\.\//, "");
        return `${DIRECTOR_BASE}/${clean}`;
    };

    const scriptSource = rewriteDirectorScript(await fetchText(toCdn(scriptMatch[1])), hostOrigin);
    const styleUrl = styleMatch ? toCdn(styleMatch[1]) : null;

    // 防止 </script> 终止内联。
    const safeScriptSource = scriptSource.replace(/<\/script/gi, "<" + String.fromCharCode(92) + "/script");
    const inlineScript = `<script type="module">${safeScriptSource}</script>`;

    const frameHtml = html
        .replace(scriptMatch[0], () => inlineScript)
        .replace(styleMatch?.[0] || "", () => styleUrl ? `<link rel="stylesheet" href="${styleUrl}">` : "");

    return { html: frameHtml, dispose: () => {} };
}

function SketchUpDirectorContent({ ctx, React }) {
    const h = React.createElement;

    const [connected, setConnected] = React.useState(false);
    const [status, setStatus] = React.useState("未连接");
    const [error, setError] = React.useState("");
    const [modelInfo, setModelInfo] = React.useState(null);
    const [directorOpen, setDirectorOpen] = React.useState(false);
    const [loading, setLoading] = React.useState("");

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const wsRef = React.useRef(null);
    const frameRef = React.useRef(null);
    const overlayRef = React.useRef(null);
    const directorReadyRef = React.useRef(false);
    const pendingModelRef = React.useRef(null);

    // ── WebSocket ──
    const connect = () => {
        setError("");
        setStatus("连接中…");
        try {
            const ws = new WebSocket(WS_URL);
            wsRef.current = ws;
            ws.onopen = () => {
                setConnected(true);
                setStatus("已连接 SketchUp ✅");
                ws.send(JSON.stringify({ type: "get_camera" }));
            };
            ws.onmessage = (event) => {
                try { handleSketchUpMessage(JSON.parse(event.data)); } catch (_e) {}
            };
            ws.onerror = () => setError("连接出错（请确认 SketchUp 已启动 CanvasSync 服务）");
            ws.onclose = () => { setConnected(false); setStatus("已断开"); };
        } catch (err) {
            setStatus("连接失败");
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const handleSketchUpMessage = (msg) => {
        if (msg.type === "model") {
            if (msg.data) {
                const model = { name: msg.name || "SketchUp模型", fileName: "sketchup-model.glb", base64: msg.data, size: msg.size };
                setModelInfo(model);
                pendingModelRef.current = model;
                setStatus(`收到模型：${model.name}（${(msg.size / 1024).toFixed(1)} KB）`);
                injectModelIfReady();
            } else if (msg.error) {
                setError(`模型导出失败：${msg.error}`);
            }
        }
    };

    // ── 导演台（srcdoc 内联，照原插件方式）──
    const openDirector = () => {
        if (directorOpen) return;
        setLoading("正在加载 3D 导演台…");
        const origin = window.location.origin;

        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#090909";
        const loadingDiv = document.createElement("div");
        loadingDiv.textContent = loading;
        loadingDiv.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:14px system-ui,sans-serif;z-index:1";
        overlay.appendChild(loadingDiv);
        document.body.appendChild(overlay);
        overlayRef.current = overlay;

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "关闭导演台";
        closeBtn.style.cssText = "position:absolute;right:16px;top:12px;z-index:2;border:1px solid #ffffff44;border-radius:8px;padding:6px 10px;background:#0008;color:#fff;cursor:pointer";
        closeBtn.onclick = closeDirector;
        overlay.appendChild(closeBtn);

        const handleMessage = (event) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const type = event.data?.type;
            if (type === "storyai:director-desk-ready") {
                directorReadyRef.current = true;
                loadingDiv.remove();
                setStatus("导演台就绪 ✅");
                injectModelIfReady();
            } else if (type === "storyai:director-desk-captures-sent") {
                const captures = Array.isArray(event.data?.payload?.captures) ? event.data.payload.captures : [];
                captures.forEach((cap) => {
                    if (typeof cap?.dataUrl === "string" && cap.dataUrl.startsWith("data:image/")) {
                        addCaptureToCanvas(cap.dataUrl, cap.fileName);
                    }
                });
                setStatus(`已回传 ${captures.length} 张截图到画布`);
            } else if (type === "storyai:director-desk-close") {
                closeDirector();
            }
        };
        window.addEventListener("message", handleMessage);
        overlayRef.current._cleanup = () => window.removeEventListener("message", handleMessage);

        setDirectorOpen(true);

        void (async () => {
            try {
                const prepared = await prepareDirectorFrame(origin);
                const frame = document.createElement("iframe");
                frame.title = "3D导演台";
                frame.allow = "fullscreen";
                frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
                frame.srcdoc = prepared.html;
                overlay.appendChild(frame);
                frameRef.current = frame;
            } catch (err) {
                loadingDiv.textContent = `导演台加载失败：${err instanceof Error ? err.message : String(err)}`;
                setStatus("加载失败");
            }
        })();
    };

    const closeDirector = () => {
        directorReadyRef.current = false;
        setDirectorOpen(false);
        if (overlayRef.current) {
            overlayRef.current._cleanup?.();
            overlayRef.current.remove();
            overlayRef.current = null;
        }
        frameRef.current = null;
    };

    const sendToDirector = (type, payload) => {
        frameRef.current?.contentWindow?.postMessage({ type, payload }, window.location.origin);
    };

    const injectModelIfReady = () => {
        const model = pendingModelRef.current;
        if (!model || !directorReadyRef.current || !frameRef.current) return;
        const dataUrl = `data:model/gltf-binary;base64,${model.base64}`;
        sendToDirector("storyai:director-desk-model", {
            sourceNodeId: ctxRef.current.node.id,
            name: model.name,
            fileName: model.fileName,
            modelUrl: dataUrl,
            modelFormat: "glb",
        });
        pendingModelRef.current = null;
        setStatus(`已注入模型到导演台：${model.name}`);
    };

    const addCaptureToCanvas = (dataUrl, fileName) => {
        const node = ctxRef.current.node;
        const id = randomId("director-capture");
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth || 800;
            const hgt = img.naturalHeight || 600;
            const scale = Math.min(1, 500 / Math.max(w, 1));
            ctxRef.current.applyOps([
                { type: "add_node", id, nodeType: "image", title: fileName || "导演台截图.png", x: node.position.x + node.width + 96, y: node.position.y, width: Math.max(120, Math.round(w * scale)), height: Math.max(90, Math.round(hgt * scale)), metadata: { content: dataUrl, status: "success", naturalWidth: w, naturalHeight: hgt, mimeType: "image/png" } },
                { type: "connect_nodes", fromNodeId: node.id, toNodeId: id },
            ]);
        };
        img.src = dataUrl;
    };

    React.useEffect(() => {
        connect();
        return () => { if (wsRef.current) wsRef.current.close(); closeDirector(); };
    }, []);

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;
    const buttonStyle = { border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 12px", background: ctx.theme.toolbar.itemHover, color: text, cursor: "pointer", fontSize: 12 };
    const primaryStyle = { ...buttonStyle, background: ctx.theme.accent || "#4c8dff", color: "#fff", fontWeight: 600 };

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🏛️"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "SketchUp → 导演台"),
        ),
        h("div", { style: { fontSize: 12 } }, `状态：${status}`),
        error ? h("div", { style: { color: "#ef9a9a", fontSize: 11, whiteSpace: "pre-wrap" } }, error) : null,
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { type: "button", style: primaryStyle, onClick: connect, disabled: connected }, connected ? "已连接" : "连接 SketchUp"),
            h("button", { type: "button", style: primaryStyle, onClick: openDirector, disabled: directorOpen }, directorOpen ? "导演台已打开" : "打开导演台"),
        ),
        modelInfo ? h("div", { style: { fontSize: 11, color: muted } }, `已接收模型：${modelInfo.name}（${(modelInfo.size / 1024).toFixed(1)} KB）`) : null,
        h("div", { style: { fontSize: 11, color: muted, lineHeight: 1.6 } },
            "1. SketchUp「扩展程序 → CanvasSync → 启动服务」",
            h("br"), "2. 本节点「连接 SketchUp」",
            h("br"), "3. SketchUp 选中模型 →「发送选中模型」",
            h("br"), "4. 「打开导演台」→ 模型自动注入为道具",
            h("br"), "5. 导演台布置人物/机位/动作 → 截图回传",
        ),
    );
}

export default function createSketchUpDirectorPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "sketchup-director",
        name: "SketchUp 导演台联动",
        version: "0.3.0",
        minAppVersion: "0.12.0",
        description: "把 SketchUp 模型导入 3D 导演台（人物/机位/动作齐全），截图回传保持 AI 生图场景一致。",
        nodes: [
            {
                type: "sketchup:director",
                title: "SketchUp 导演台联动",
                icon: "🏛️",
                description: "SketchUp 模型 → 3D 导演台 → 截图回传",
                defaultSize: { width: 400, height: 400 },
                defaultMetadata: {},
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => SketchUpDirectorContent({ ...props, React }),
            },
        ],
    };
}
