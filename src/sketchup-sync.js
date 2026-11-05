// Infinite Canvas SketchUp 同步节点插件。
// 连接本地 ws://127.0.0.1:8899（SketchUp Ruby 插件起的服务），
// 实时接收相机参数 + 按需截图，显示取景框预览，导出高清图回传画布。
// 无需传输模型几何、无需改宿主后端。

const WS_URL = "ws://127.0.0.1:8899";

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const ASPECTS = [
    { label: "16:9", w: 16, h: 9 },
    { label: "4:3", w: 4, h: 3 },
    { label: "1:1", w: 1, h: 1 },
    { label: "9:16", w: 9, h: 16 },
    { label: "3:4", w: 3, h: 4 },
];

function SketchUpSyncContent({ ctx, React }) {
    const h = React.createElement;

    const [connected, setConnected] = React.useState(false);
    const [camera, setCamera] = React.useState(null);      // 相机参数
    const [preview, setPreview] = React.useState(null);     // 当前预览图 dataURL
    const [previewSize, setPreviewSize] = React.useState(""); // 预览图尺寸说明
    const [aspect, setAspect] = React.useState({ label: "16:9", w: 16, h: 9 });
    const [models, setModels] = React.useState([]);
    const [scenes, setScenes] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState("未连接");
    const [error, setError] = React.useState("");

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const wsRef = React.useRef(null);
    const reconnectTimerRef = React.useRef(null);

    const send = (obj) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify(obj));
        }
    };

    const connect = () => {
        setError("");
        setStatus("连接中…");
        try {
            const ws = new WebSocket(WS_URL);
            wsRef.current = ws;
            ws.onopen = () => {
                setConnected(true);
                setStatus("已连接 SketchUp ✅");
                // 连接后立即请求相机 + 模型 + 场景 + 设定长宽比。
                send({ type: "get_camera" });
                send({ type: "get_models" });
                send({ type: "get_scenes" });
                send({ type: "set_aspect", w: aspect.w, h: aspect.h });
            };
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    handleMessage(msg);
                } catch (_e) { /* 忽略非 JSON */ }
            };
            ws.onerror = () => {
                setError("WebSocket 连接出错（请确认 SketchUp 里已启动 CanvasSync 服务）");
            };
            ws.onclose = () => {
                setConnected(false);
                setStatus("已断开");
                if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = setTimeout(() => { if (wsRef.current === ws) connect(); }, 3000);
            };
        } catch (err) {
            setStatus("连接失败");
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const handleMessage = (msg) => {
        switch (msg.type) {
            case "camera":
                setCamera(msg);
                break;
            case "snapshot":
                setPreview(msg.data);
                setPreviewSize(`${msg.width}×${msg.height}`);
                setBusy(false);
                break;
            case "models":
                setModels(msg.items || []);
                break;
            case "scenes":
                setScenes(msg.items || []);
                break;
        }
    };

    // 请求截图（小图/中图/高清）。
    const requestSnapshot = (width) => {
        if (!connected) { setStatus("请先连接 SketchUp"); return; }
        setBusy(true);
        setStatus(`正在截图 ${width}px…`);
        send({ type: "snapshot", width });
    };

    // 实时小图：连接后定时拉小图。
    const startLivePreview = () => {
        if (!connected) return;
        send({ type: "snapshot", width: 320 });
    };

    React.useEffect(() => {
        connect();
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        };
    }, []);

    // 长宽比变化时同步给 SketchUp。
    React.useEffect(() => {
        if (connected) send({ type: "set_aspect", w: aspect.w, h: aspect.h });
    }, [aspect, connected]);

    // 导出高清图回传画布。
    const exportHighRes = async () => {
        if (!connected) { setStatus("请先连接 SketchUp"); return; }
        setBusy(true);
        setStatus("正在导出 2048 高清图…");
        // 临时监听一次 snapshot 大图。
        const handler = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === "snapshot" && msg.width >= 2048) {
                    wsRef.current.removeEventListener("message", handler);
                    addToCanvas(msg.data, msg.width, msg.height);
                    setStatus("已回传 2048 高清图到画布");
                    setBusy(false);
                }
            } catch (_e) {}
        };
        wsRef.current.addEventListener("message", handler);
        send({ type: "snapshot", width: 2048 });
    };

    const addToCanvas = (dataUrl, w, hgt) => {
        const node = ctxRef.current.node;
        const scale = Math.min(1, 600 / Math.max(w, 1));
        const id = randomId("su-snap");
        ctxRef.current.applyOps([
            {
                type: "add_node", id, nodeType: "image", title: `SketchUp截图-${w}x${hgt}.png`,
                x: node.position.x + node.width + 96, y: node.position.y,
                width: Math.max(120, Math.round(w * scale)), height: Math.max(90, Math.round(hgt * scale)),
                metadata: { content: dataUrl, status: "success", naturalWidth: w, naturalHeight: hgt, mimeType: "image/png" },
            },
            { type: "connect_nodes", fromNodeId: node.id, toNodeId: id },
        ]);
    };

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;
    const labelStyle = { fontSize: 11, color: muted, marginBottom: 3 };
    const buttonStyle = {
        border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 12px", background: ctx.theme.toolbar.itemHover, color: text, cursor: "pointer", fontSize: 12,
    };
    const primaryStyle = { ...buttonStyle, background: ctx.theme.accent || "#4c8dff", color: "#fff", fontWeight: 600 };

    const aspectRatio = aspect.w / aspect.h;

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🏛️"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "SketchUp 同步"),
        ),
        // 连接状态 + 控制
        h("div", { style: { fontSize: 12 } }, `状态：${status}`),
        error ? h("div", { style: { color: "#ef9a9a", fontSize: 11, whiteSpace: "pre-wrap" } }, error) : null,
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { type: "button", style: primaryStyle, onClick: connect, disabled: connected }, connected ? "已连接" : "连接 SketchUp"),
            h("button", { type: "button", style: buttonStyle, onClick: startLivePreview, disabled: !connected }, "实时小图(320)"),
            h("button", { type: "button", style: buttonStyle, onClick: () => requestSnapshot(1024), disabled: !connected }, "静止中图(1024)"),
            h("button", { type: "button", style: primaryStyle, onClick: exportHighRes, disabled: !connected || busy }, busy ? "处理中…" : "导出高清(2048)"),
        ),
        // 长宽比选择
        h("div", null,
            h("div", { style: labelStyle }, "取景长宽比（同步到 SketchUp 截图）"),
            h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                ASPECTS.map((a) =>
                    h("button", {
                        type: "button",
                        key: a.label,
                        style: { ...buttonStyle, padding: "4px 10px", background: aspect.label === a.label ? (ctx.theme.accent || "#4c8dff") : ctx.theme.toolbar.itemHover, color: aspect.label === a.label ? "#fff" : text },
                        onClick: () => setAspect(a),
                    }, a.label),
                ),
            ),
        ),
        // 取景框预览
        h("div", { style: { position: "relative", width: "100%", aspectRatio: String(aspectRatio), borderRadius: 8, overflow: "hidden", border: `2px solid ${stroke}`, background: "#000", display: "flex", alignItems: "center", justifyContent: "center" } },
            preview
                ? h("img", { src: preview, alt: "SketchUp 预览", style: { width: "100%", height: "100%", objectFit: "cover" } })
                : h("div", { style: { color: muted, fontSize: 12 } }, "取景框（等待截图）"),
            previewSize ? h("div", { style: { position: "absolute", right: 4, top: 4, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 10, padding: "1px 5px", borderRadius: 4 } }, previewSize) : null,
        ),
        // 相机参数
        camera
            ? h("div", { style: { fontSize: 11, color: muted, whiteSpace: "pre-wrap", border: `1px solid ${stroke}`, borderRadius: 6, padding: 6 } },
                `相机 eye(${camera.eye.map((n) => n.toFixed(1)).join(", ")})\nfov ${camera.fov?.toFixed(1)}° · ${camera.perspective ? "透视" : "正交"} · 视口 ${camera.vpwidth}×${camera.vpheight}`,
            )
            : null,
        // 场景 / 模型信息
        scenes.length || models.length
            ? h("div", { style: { fontSize: 11, color: muted } },
                scenes.length ? h("div", null, `场景：${scenes.join("、")}`) : null,
                models.length ? h("div", null, `组件：${models.length} 个（${models.map((m) => m.name).slice(0, 5).join("、")}${models.length > 5 ? "…" : ""}）`) : null,
            )
            : null,
        h("div", { style: { fontSize: 10, color: muted, borderTop: `1px solid ${stroke}`, paddingTop: 6 } }, "提示：请先在 SketchUp 的「扩展程序」菜单里启动 CanvasSync 服务。"),
    );
}

export default function createSketchUpSyncPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "sketchup-sync",
        name: "SketchUp 同步",
        version: "0.1.0",
        minAppVersion: "0.12.0",
        description: "同步 SketchUp 相机与截图，取景框预览，导出高清图回传画布。",
        nodes: [
            {
                type: "sketchup:sync",
                title: "SketchUp 同步",
                icon: "🏛️",
                description: "同步 SketchUp 相机/截图，取景框预览与高清导出",
                defaultSize: { width: 380, height: 640 },
                defaultMetadata: {},
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => SketchUpSyncContent({ ...props, React }),
            },
        ],
    };
}
