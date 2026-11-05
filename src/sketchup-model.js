// Infinite Canvas SketchUp 同步节点 —— 分层渲染架构（用户原始设计）。
//
// 设计意图：
//   - 实时层：相机参数 + 选中的模型（轻量几何），用 Three.js 随相机实时渲染
//   - 兜底层：SketchUp 当前相机的截图（截图时隐藏选中模型，避免重影），原位叠在最底层
//   - 两者共用完全相同的相机（eye/target/fov/aspect），因此严丝合缝对齐
//
// 性能与质量兼顾：选中模型是纯 3D（任意角度都准），其余内容用截图（SU 真实渲染质量）。

const WS_URL = "ws://127.0.0.1:8899";
const THREE_BASE = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const GLTFLOADER_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
// 改造版 3D 导演台（保留人物/机位/动作，新增 SketchUp 模型注入 + 相机同步协议）。
const DIRECTOR_BASE = "https://cdn.jsdelivr.net/gh/wudidekongjv/director-desk@ff10f8813b5d5a33f22dee1702d7010e62fd1f77";

// ── 导演台 srcdoc 内联（照 esncy 原插件方式，避免跨域、无需单独部署）──
function cacheBusted(url) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

async function fetchText(url) {
    const response = await fetch(cacheBusted(url), { cache: "no-store" });
    if (!response.ok) throw new Error(`导演台资源下载失败 (${response.status})`);
    return response.text();
}

function toCdnPath(p) {
    return `${DIRECTOR_BASE}/${p.replace(/^\/director\//, "").replace(/^\.\//, "")}`;
}

async function prepareDirectorFrame(hostOrigin) {
    const html = await fetchText(`${DIRECTOR_BASE}/index.html`);
    const scriptMatch = html.match(/<script[^>]+src=["']([^"']+)["'][^>]*>/i);
    const styleMatch = html.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
    if (!scriptMatch) throw new Error("导演台缺少脚本入口");

    const rawScript = await fetchText(toCdnPath(scriptMatch[1]));
    // 把 JS 内的 /director/ 路径改写到 CDN，并把 origin 指向宿主。
    const scriptSource = rawScript
        .replace(/\/director\//g, `${DIRECTOR_BASE}/`)
        .replace(/window\.location\.origin/g, JSON.stringify(hostOrigin));

    const styleUrl = styleMatch ? toCdnPath(styleMatch[1]) : null;
    const safe = scriptSource.replace(/<\/script/gi, "<" + String.fromCharCode(92) + "/script");
    const frameHtml = html
        .replace(scriptMatch[0], () => `<script type="module">${safe}</script>`)
        .replace(styleMatch?.[0] || "", () => styleUrl ? `<link rel="stylesheet" href="${styleUrl}">` : "");

    return frameHtml;
}

const ASPECTS = [
    { label: "16:9", w: 16, h: 9 },
    { label: "4:3", w: 4, h: 3 },
    { label: "1:1", w: 1, h: 1 },
    { label: "9:16", w: 9, h: 16 },
    { label: "3:4", w: 3, h: 4 },
];

let threePromise = null;
function loadThree() {
    if (!threePromise) threePromise = import(/* @vite-ignore */ THREE_BASE);
    return threePromise;
}

let gltfLoaderPromise = null;
function loadGLTFLoader() {
    if (!gltfLoaderPromise) {
        gltfLoaderPromise = import(/* @vite-ignore */ GLTFLOADER_URL).then((mod) => mod.GLTFLoader || mod.default);
    }
    return gltfLoaderPromise;
}

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SketchUpSyncContent({ ctx, React }) {
    const h = React.createElement;

    const [connected, setConnected] = React.useState(false);
    const [status, setStatus] = React.useState("未连接");
    const [error, setError] = React.useState("");
    const [aspect, setAspect] = React.useState(ASPECTS[0]);
    const [camera, setCamera] = React.useState(null);
    const [modelInfo, setModelInfo] = React.useState(null);
    const [backdrop, setBackdrop] = React.useState(null);
    const [autoSync, setAutoSync] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [directorOpen, setDirectorOpen] = React.useState(false);
    const [directorStatus, setDirectorStatus] = React.useState("");
    const [followSu, setFollowSu] = React.useState(false); // 导演台是否跟随 SU 视角（默认关，避免锁死）
    const followRef = React.useRef(false);
    followRef.current = followSu;

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const wsRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const sceneRef = React.useRef(null);
    const aspectRef = React.useRef(aspect);
    const autoSyncRef = React.useRef(autoSync);
    const snapTimerRef = React.useRef(null);
    const lastSnapRef = React.useRef(0);
    // 导演台相关
    const frameRef = React.useRef(null);
    const overlayRef = React.useRef(null);
    const directorReadyRef = React.useRef(false);
    const lastModelRef = React.useRef(null);
    const lastCameraRef = React.useRef(null);
    const lastBackdropRef = React.useRef(null);
    aspectRef.current = aspect;
    autoSyncRef.current = autoSync;

    // ── Three.js 场景（只放选中模型，透明背景让底层截图透出）──
    const initScene = async () => {
        if (sceneRef.current) return sceneRef.current;
        const THREE = await loadThree();
        const canvas = canvasRef.current;
        if (!canvas) return null;

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        const w = canvas.clientWidth || 480;
        const hgt = canvas.clientHeight || 270;
        renderer.setSize(w, hgt, false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearAlpha(0);

        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const dir = new THREE.DirectionalLight(0xffffff, 1.15);
        dir.position.set(3, 8, 5);
        scene.add(dir);
        const dir2 = new THREE.DirectionalLight(0xffffff, 0.45);
        dir2.position.set(-4, 4, -6);
        scene.add(dir2);

        const cam = new THREE.PerspectiveCamera(35, w / hgt, 0.01, 5000);
        cam.position.set(5, 3, 5);
        cam.lookAt(0, 0, 0);

        sceneRef.current = { renderer, scene, camera: cam, model: null, THREE };
        render();
        return sceneRef.current;
    };

    const render = () => {
        const s = sceneRef.current;
        if (s) s.renderer.render(s.scene, s.camera);
    };

    // ── 相机同步：与 SketchUp 完全一致的 eye / target / fov / aspect ──
    const applyCamera = async (msg) => {
        if (!msg?.eye || !msg?.target) return;
        const s = await initScene();
        if (!s) return;
        const cam = s.camera;
        cam.position.set(msg.eye[0], msg.eye[1], msg.eye[2]);
        cam.up.set(0, 1, 0);
        cam.lookAt(msg.target[0], msg.target[1], msg.target[2]);
        if (Number.isFinite(msg.fov) && msg.fov > 0) cam.fov = msg.fov;
        const a = aspectRef.current;
        cam.aspect = a.w / a.h;
        cam.updateProjectionMatrix();
        render();
    };

    // ── 加载选中模型 ──
    const loadModel = async (base64) => {
        const s = await initScene();
        if (!s) return;
        const GLTFLoader = await loadGLTFLoader();
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const loader = new GLTFLoader();
        const gltf = await new Promise((res, rej) => loader.parse(bytes.buffer, "", res, rej));

        if (s.model) {
            s.scene.remove(s.model);
            s.model.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach((m) => m.dispose());
                }
            });
        }
        s.model = gltf.scene;
        s.model.traverse((o) => {
            if (o.isMesh && o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => { m.side = s.THREE.DoubleSide; });
            }
        });
        s.scene.add(s.model);
        // 模型加载后立即重渲染一次（应用当前相机）。
        if (camera) void applyCamera(camera);
        render();
    };

    // ── 截图请求（含防抖）──
    const requestSnapshot = (width, hideSelection, silent) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== 1) return;
        if (!silent) setBusy(true);
        ws.send(JSON.stringify({ type: "snapshot", width, hide_selection: hideSelection === true }));
    };

    const scheduleSnapshot = () => {
        if (!autoSyncRef.current) return;
        if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
        snapTimerRef.current = setTimeout(() => {
            const now = Date.now();
            if (now - lastSnapRef.current < 280) return;
            lastSnapRef.current = now;
            requestSnapshot(640, true, true);
        }, 420);
    };

    // ── 导演台（srcdoc 内联）──
    const sendToDirector = (type, payload) => {
        frameRef.current?.contentWindow?.postMessage({ type, payload }, window.location.origin);
    };

    const pushToDirector = () => {
        if (!directorReadyRef.current || !frameRef.current) return;
        const m = lastModelRef.current;
        if (m?.base64) {
            sendToDirector("storyai:director-desk-model", {
                sourceNodeId: ctxRef.current.node.id,
                name: m.name,
                fileName: "sketchup-model.glb",
                modelUrl: `data:model/gltf-binary;base64,${m.base64}`,
                modelFormat: "glb",
            });
        }
        const c = lastCameraRef.current;
        if (c?.eye && c?.target) {
            sendToDirector("storyai:director-desk-camera", { eye: c.eye, target: c.target, fov: c.fov, follow: followRef.current });
        }
        const bd = lastBackdropRef.current;
        if (bd) {
            sendToDirector("storyai:director-desk-backdrop", { dataUrl: bd, enabled: true });
        }
    };

    const openDirector = async () => {
        if (directorOpen) return;
        const origin = window.location.origin;
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#090909";
        document.body.appendChild(overlay);
        overlayRef.current = overlay;

        const loadingDiv = document.createElement("div");
        loadingDiv.textContent = "正在加载 3D 导演台…";
        loadingDiv.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:14px system-ui,sans-serif;z-index:1";
        overlay.appendChild(loadingDiv);

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "关闭导演台";
        closeBtn.style.cssText = "position:absolute;right:16px;top:12px;z-index:3;border:1px solid #ffffff44;border-radius:8px;padding:6px 10px;background:#0008;color:#fff;cursor:pointer";
        closeBtn.onclick = closeDirector;
        overlay.appendChild(closeBtn);

        const handleMessage = (event) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const type = event.data?.type;
            if (type === "storyai:director-desk-ready") {
                directorReadyRef.current = true;
                loadingDiv.remove();
                setDirectorStatus("导演台就绪 ✅");
                pushToDirector();
            } else if (type === "storyai:director-desk-captures-sent") {
                const caps = Array.isArray(event.data?.payload?.captures) ? event.data.payload.captures : [];
                caps.forEach((cap) => {
                    if (typeof cap?.dataUrl === "string" && cap.dataUrl.startsWith("data:image/")) {
                        exportToCanvas(cap.dataUrl, cap.fileName);
                    }
                });
                setDirectorStatus(`已回传 ${caps.length} 张导演台截图`);
            } else if (type === "storyai:director-desk-close") {
                closeDirector();
            } else if (type === "storyai:director-desk-viewport-changed") {
                // 反向控制：导演台视角变化 → 回写 SketchUp 相机。
                const p = event.data?.payload;
                if (p?.eye && p?.target && wsRef.current?.readyState === 1) {
                    wsRef.current.send(JSON.stringify({
                        type: "set_camera",
                        eye: p.eye,
                        target: p.target,
                        fov: p.fov,
                    }));
                }
            }
        };
        window.addEventListener("message", handleMessage);
        overlay._cleanup = () => window.removeEventListener("message", handleMessage);

        setDirectorOpen(true);
        setDirectorStatus("加载中…");

        try {
            const frameHtml = await prepareDirectorFrame(origin);
            const frame = document.createElement("iframe");
            frame.title = "3D导演台";
            frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
            frame.srcdoc = frameHtml;
            overlay.appendChild(frame);
            frameRef.current = frame;
        } catch (err) {
            loadingDiv.textContent = `导演台加载失败：${err instanceof Error ? err.message : String(err)}`;
            setDirectorStatus("加载失败");
        }
    };

    const closeDirector = () => {
        directorReadyRef.current = false;
        setDirectorOpen(false);
        setDirectorStatus("");
        if (overlayRef.current) {
            overlayRef.current._cleanup?.();
            overlayRef.current.remove();
            overlayRef.current = null;
        }
        frameRef.current = null;
    };

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
                ws.send(JSON.stringify({ type: "set_aspect", w: aspectRef.current.w, h: aspectRef.current.h }));
                ws.send(JSON.stringify({ type: "get_camera" }));
            };
            ws.onmessage = (event) => {
                try { handleMessage(JSON.parse(event.data)); } catch (_e) {}
            };
            ws.onerror = () => setError("连接出错（请确认 SketchUp 已启动 CanvasSync 服务）");
            ws.onclose = () => { setConnected(false); setStatus("已断开"); };
        } catch (err) {
            setStatus("连接失败");
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const handleMessage = (msg) => {
        if (msg.type === "camera") {
            if (msg.eye) {
                lastCameraRef.current = msg;
                setCamera(msg);
                void applyCamera(msg);
                scheduleSnapshot();
                // 转发给导演台（若已打开）：实现导演台实时跟随 SU 视角。
                if (directorReadyRef.current) {
                    sendToDirector("storyai:director-desk-camera", {
                        eye: msg.eye, target: msg.target, fov: msg.fov, follow: followRef.current,
                    });
                }
            }
            return;
        }
        if (msg.type === "model") {
            if (msg.data) {
                const info = { name: msg.name || "SketchUp模型", size: msg.size, bbox: msg.bbox || null, base64: msg.data };
                setModelInfo({ name: info.name, size: info.size, bbox: info.bbox });
                lastModelRef.current = info;
                const bboxText = msg.bbox ? `（${msg.bbox.width.toFixed(2)}×${msg.bbox.height.toFixed(2)}×${msg.bbox.depth.toFixed(2)} m）` : "";
                setStatus(`模型已加载：${info.name}${bboxText}`);
                void loadModel(msg.data);
                if (directorReadyRef.current) pushToDirector();
            } else if (msg.error) {
                setError(`模型导出失败：${msg.error}`);
            }
            return;
        }
        if (msg.type === "snapshot") {
            if (msg.data) {
                setBackdrop(msg.data);
                lastBackdropRef.current = msg.data;
                // 背景截图（隐藏选中模型）→ 同步到导演台的摄像机视角底图。
                if (msg.hide_selection === true && directorReadyRef.current) {
                    sendToDirector("storyai:director-desk-backdrop", { dataUrl: msg.data, enabled: true });
                }
                if (msg.hide_selection !== true) {
                    // 高清导出（含选中模型）→ 回传画布
                    exportToCanvas(msg.data);
                }
            } else if (msg.error) {
                setError(`截图失败：${msg.error}`);
            }
            setBusy(false);
            return;
        }
        if (msg.type === "error") setError(msg.message || "未知错误");
    };

    // ── 导出高清到画布 ──
    const exportHighRes = () => {
        if (!connected) { setStatus("请先连接 SketchUp"); return; }
        setStatus("正在导出高清截图…");
        requestSnapshot(2048, false, false);
    };

    const exportToCanvas = (dataUrl, fileName) => {
        const node = ctxRef.current.node;
        const id = randomId("su-capture");
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth || 2048;
            const hgt = img.naturalHeight || 1152;
            const scale = Math.min(1, 560 / Math.max(w, 1));
            ctxRef.current.applyOps([
                {
                    type: "add_node", id, nodeType: "image", title: fileName || "SketchUp机位截图.png",
                    x: node.position.x + node.width + 96, y: node.position.y,
                    width: Math.max(160, Math.round(w * scale)), height: Math.max(90, Math.round(hgt * scale)),
                    metadata: { content: dataUrl, status: "success", naturalWidth: w, naturalHeight: hgt, mimeType: "image/png" },
                },
                { type: "connect_nodes", fromNodeId: node.id, toNodeId: id },
            ]);
            setStatus("已回传截图到画布");
            setBusy(false);
        };
        img.src = dataUrl;
    };

    // 长宽比变化 → 同步 SketchUp + 重渲染。
    React.useEffect(() => {
        const ws = wsRef.current;
        if (connected && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "set_aspect", w: aspect.w, h: aspect.h }));
            requestSnapshot(640, true, true);
        }
        const s = sceneRef.current;
        if (s) {
            s.camera.aspect = aspect.w / aspect.h;
            s.camera.updateProjectionMatrix();
            render();
        }
    }, [aspect, connected]);

    // 每次渲染同步 renderer 尺寸。
    React.useEffect(() => {
        const s = sceneRef.current;
        const canvas = canvasRef.current;
        if (!s || !canvas) return;
        const w = canvas.clientWidth;
        const hgt = canvas.clientHeight;
        if (w > 0 && hgt > 0) {
            s.renderer.setSize(w, hgt, false);
            s.camera.updateProjectionMatrix();
            render();
        }
    });

    React.useEffect(() => {
        connect();
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
        };
    }, []);

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;
    const labelStyle = { fontSize: 11, color: muted, marginBottom: 3 };
    const buttonStyle = {
        border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 12px", background: ctx.theme.toolbar.itemHover, color: text, cursor: "pointer", fontSize: 12,
    };
    const primaryStyle = { ...buttonStyle, background: ctx.theme.accent || "#4c8dff", color: "#fff", fontWeight: 600 };

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🏛️"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "SketchUp 同步"),
        ),
        h("div", { style: { fontSize: 12 } }, `状态：${status}`),
        error ? h("div", { style: { color: "#ef9a9a", fontSize: 11, whiteSpace: "pre-wrap" } }, error) : null,

        // 取景框：底层截图 + 上层 3D 模型
        h("div", {
            style: {
                position: "relative", width: "100%", aspectRatio: `${aspect.w} / ${aspect.h}`,
                borderRadius: 8, overflow: "hidden", border: `1px solid ${stroke}`,
                background: "#1a1a1a",
            },
        },
            backdrop
                ? h("img", { src: backdrop, alt: "SketchUp 背景", style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" } })
                : h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", color: muted, fontSize: 12 } }, "等待 SketchUp 画面…"),
            h("canvas", {
                ref: canvasRef,
                style: { position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", pointerEvents: "none" },
            }),
        ),

        h("div", null,
            h("div", { style: labelStyle }, "取景长宽比"),
            h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                ASPECTS.map((a) => h("button", {
                    type: "button", key: a.label,
                    style: { ...buttonStyle, padding: "4px 10px", background: aspect.label === a.label ? (ctx.theme.accent || "#4c8dff") : ctx.theme.toolbar.itemHover, color: aspect.label === a.label ? "#fff" : text },
                    onClick: () => setAspect(a),
                }, a.label)),
            ),
        ),

        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { type: "button", style: primaryStyle, onClick: connect, disabled: connected }, connected ? "已连接" : "连接 SketchUp"),
            h("button", { type: "button", style: buttonStyle, onClick: () => requestSnapshot(640, true, false), disabled: !connected }, "刷新背景"),
            h("button", { type: "button", style: primaryStyle, onClick: exportHighRes, disabled: !connected || busy }, busy ? "处理中…" : "导出高清(2048)"),
        ),

        // 导演台入口
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("button", { type: "button", style: { ...primaryStyle, background: "#7c5cff" }, onClick: openDirector, disabled: directorOpen }, directorOpen ? "导演台已打开" : "🎬 打开 3D 导演台"),
            directorStatus ? h("span", { style: { fontSize: 11, color: muted } }, directorStatus) : null,
        ),
        // 双向控制开关
        h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: muted } },
            h("label", { style: { display: "flex", alignItems: "center", gap: 5 } },
                h("input", { type: "checkbox", checked: followSu, onChange: (e) => setFollowSu(e.target.checked) }),
                "导演台跟随 SU 视角",
            ),
            h("span", { style: { opacity: 0.7 } }, "（导演台转视角会自动回写 SU）"),
        ),

        h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: muted } },
            h("input", { type: "checkbox", checked: autoSync, onChange: (e) => setAutoSync(e.target.checked) }),
            "相机停止后自动刷新背景",
        ),

        modelInfo
            ? h("div", { style: { fontSize: 11, color: muted } },
                `模型：${modelInfo.name}（${(modelInfo.size / 1024).toFixed(1)} KB）`,
                modelInfo.bbox ? ` · ${modelInfo.bbox.width.toFixed(2)}×${modelInfo.bbox.height.toFixed(2)}×${modelInfo.bbox.depth.toFixed(2)} m` : "",
            )
            : null,
        camera
            ? h("div", { style: { fontSize: 10, color: muted, whiteSpace: "pre-wrap" } },
                `相机 eye(${camera.eye.map((n) => n.toFixed(2)).join(", ")}) · fov ${camera.fov?.toFixed(1)}°`)
            : null,

        h("div", { style: { fontSize: 10, color: muted, borderTop: `1px solid ${stroke}`, paddingTop: 6, lineHeight: 1.6 } },
            "分层渲染：底层 = SketchUp 截图（含全部场景），上层 = 选中模型的实时 3D。同一相机，自动对齐。",
            h("br"),
            "① SketchUp「CanvasSync → 启动服务」② 选中模型 →「发送选中模型」③ 拖动 SU 视角，本节点实时跟随",
        ),
    );
}

export default function createSketchUpSyncPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "sketchup-sync",
        name: "SketchUp 同步",
        version: "0.5.0",
        minAppVersion: "0.12.0",
        description: "SketchUp 相机实时同步 + 选中模型 3D 叠加 + 截图分层渲染。",
        nodes: [
            {
                type: "sketchup:sync",
                title: "SketchUp 同步",
                icon: "🏛️",
                description: "SU 相机实时同步 / 选中模型 3D 叠加 / 截图分层",
                defaultSize: { width: 440, height: 560 },
                defaultMetadata: {},
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => SketchUpSyncContent({ ...props, React }),
            },
        ],
    };
}
