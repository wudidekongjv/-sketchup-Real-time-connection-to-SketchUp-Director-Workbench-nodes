// Infinite Canvas SketchUp ↔ 导演台 联动节点。
// 功能：
//   1) 连接本地 ws://127.0.0.1:8899（SketchUp Ruby 插件）
//   2) 接收 SketchUp 选中的模型（glb base64）
//   3) 打开改造版 3D 导演台 iframe，把模型作为 prop 注入场景
//   4) 导演台截图回传画布（供 AI 生图保持场景一致）
// 导演台 = xiaozangao/3d-director-desk 改造版（新增 model 注入协议），部署在 jsDelivr。

const WS_URL = "ws://127.0.0.1:8899";
const DIRECTOR_BASE = "https://cdn.jsdelivr.net/gh/wudidekongjv/director-desk@main";

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SketchUpDirectorContent({ ctx, React }) {
    const h = React.createElement;

    const [connected, setConnected] = React.useState(false);
    const [status, setStatus] = React.useState("未连接");
    const [error, setError] = React.useState("");
    const [modelInfo, setModelInfo] = React.useState(null);
    const [directorOpen, setDirectorOpen] = React.useState(false);
    const [pendingModel, setPendingModel] = React.useState(null); // { name, fileName, base64 }

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const wsRef = React.useRef(null);
    const frameRef = React.useRef(null);
    const overlayRef = React.useRef(null);
    const directorReadyRef = React.useRef(false);
    const pendingModelRef = React.useRef(null);

    // ── WebSocket：接收 SketchUp 数据 ──
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
                try {
                    const msg = JSON.parse(event.data);
                    handleSketchUpMessage(msg);
                } catch (_e) { /* 非 JSON */ }
            };
            ws.onerror = () => setError("连接出错（请确认 SketchUp 已启动 CanvasSync 服务）");
            ws.onclose = () => {
                setConnected(false);
                setStatus("已断开");
            };
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
                setPendingModel(model);
                pendingModelRef.current = model;
                setStatus(`收到模型：${model.name}（${(msg.size / 1024).toFixed(1)} KB）`);
                // 如果导演台已打开且就绪，立即注入；否则等打开后注入。
                injectModelIfReady();
            } else if (msg.error) {
                setError(`模型导出失败：${msg.error}`);
            }
        }
    };

    // ── 导演台 iframe ──
    const openDirector = () => {
        if (directorOpen) return;
        const origin = window.location.origin;
        const instanceId = `sketchup-${ctxRef.current.node.id}`;
        const src = `${DIRECTOR_BASE}/index.html?instanceId=${encodeURIComponent(instanceId)}&hostOrigin=${encodeURIComponent(origin)}&theme=dark`;

        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#090909";
        document.body.appendChild(overlay);
        overlayRef.current = overlay;

        const iframe = document.createElement("iframe");
        iframe.title = "3D导演台";
        iframe.allow = "fullscreen";
        iframe.referrerPolicy = "no-referrer";
        iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
        iframe.src = src;
        overlay.appendChild(iframe);
        frameRef.current = iframe;

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "关闭导演台";
        closeBtn.style.cssText = "position:absolute;right:16px;top:12px;z-index:2;border:1px solid #ffffff44;border-radius:8px;padding:6px 10px;background:#0008;color:#fff;cursor:pointer";
        closeBtn.onclick = closeDirector;
        overlay.appendChild(closeBtn);

        setDirectorOpen(true);
        setStatus("导演台已打开，等待加载…");

        // 监听导演台消息。
        const handleMessage = (event) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const type = event.data?.type;
            if (type === "storyai:director-desk-ready") {
                directorReadyRef.current = true;
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
        frameRef.current?.contentWindow?.postMessage({ type, payload }, "*");
    };

    const injectModelIfReady = () => {
        const model = pendingModelRef.current;
        if (!model || !directorReadyRef.current || !frameRef.current) return;
        // 注入模型（base64 → dataUrl）。
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
                {
                    type: "add_node", id, nodeType: "image",
                    title: fileName || "导演台截图.png",
                    x: node.position.x + node.width + 96, y: node.position.y,
                    width: Math.max(120, Math.round(w * scale)), height: Math.max(90, Math.round(hgt * scale)),
                    metadata: { content: dataUrl, status: "success", naturalWidth: w, naturalHeight: hgt, mimeType: "image/png" },
                },
                { type: "connect_nodes", fromNodeId: node.id, toNodeId: id },
            ]);
        };
        img.src = dataUrl;
    };

    React.useEffect(() => {
        connect();
        return () => {
            if (wsRef.current) wsRef.current.close();
            closeDirector();
        };
    }, []);

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;
    const buttonStyle = {
        border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 12px", background: ctx.theme.toolbar.itemHover, color: text, cursor: "pointer", fontSize: 12,
    };
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
        modelInfo
            ? h("div", { style: { fontSize: 11, color: muted } }, `已接收模型：${modelInfo.name}（${(modelInfo.size / 1024).toFixed(1)} KB）`)
            : null,
        h("div", { style: { fontSize: 11, color: muted, lineHeight: 1.6 } },
            "使用步骤：",
            h("br"),
            "1. SketchUp 菜单「扩展程序 → CanvasSync → 启动服务」",
            h("br"),
            "2. 本节点点「连接 SketchUp」",
            h("br"),
            "3. SketchUp 里选中模型 → 「CanvasSync → 发送选中模型」",
            h("br"),
            "4. 点「打开导演台」，模型会自动注入为场景道具",
            h("br"),
            "5. 在导演台里布置人物/机位/动作，截图自动回传画布",
        ),
        h("div", { style: { fontSize: 10, color: muted, borderTop: `1px solid ${stroke}`, paddingTop: 6 } }, "提示：导演台保留人物/机位/动作全部功能，SketchUp 模型作为场景道具接入，保证 AI 生图场景一致。"),
    );
}

export default function createSketchUpDirectorPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "sketchup-director",
        name: "SketchUp 导演台联动",
        version: "0.2.0",
        minAppVersion: "0.12.0",
        description: "把 SketchUp 选中模型导入 3D 导演台作为场景，保留人物/机位/动作功能，截图回传保持 AI 生图场景一致。",
        nodes: [
            {
                type: "sketchup:director",
                title: "SketchUp 导演台联动",
                icon: "🏛️",
                description: "SketchUp 模型 → 3D 导演台（人物/机位/动作）→ 截图回传",
                defaultSize: { width: 400, height: 420 },
                defaultMetadata: {},
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => SketchUpDirectorContent({ ...props, React }),
            },
        ],
    };
}
