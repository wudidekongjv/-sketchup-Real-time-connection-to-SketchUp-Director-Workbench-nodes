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
const DIRECTOR_BASE = "https://cdn.jsdelivr.net/gh/wudidekongjv/director-desk@e91d7410cb30128421db52be69c9ddaa3e72d0ba";

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

async function prepareDirectorFrame(hostOrigin, instanceId) {
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
    // srcdoc 没有 URL 参数，注入全局变量让导演台直接进入指定实例（跳过首页）。
    const boot = `<script>window.__DIRECTOR_DESK_BOOT__=${JSON.stringify({ instanceId, theme: "dark" })};</script>`;

    let frameHtml = html
        .replace(scriptMatch[0], () => `<script type="module">${safe}</script>`)
        .replace(styleMatch?.[0] || "", () => styleUrl ? `<link rel="stylesheet" href="${styleUrl}">` : "");

    frameHtml = frameHtml.replace(/<head>/i, (m) => `<head>${boot}`);
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

// 把 SketchUp 的 fov 统一转换成「垂直视场角」（Three.js 用垂直 fov）。
function toVerticalFov(msg, aspectW, aspectH) {
    const fov = Number(msg?.fov);
    const safe = Number.isFinite(fov) && fov > 0 ? fov : 35;
    if (msg?.fov_is_height === false) {
        // SketchUp 的 fov 按宽度测量 → 换算成垂直。
        const aspect = (aspectW || 16) / (aspectH || 9);
        return (2 * Math.atan(Math.tan((safe * Math.PI) / 180 / 2) / aspect)) * 180 / Math.PI;
    }
    return safe;
}

// 模块级持久引用：iframe 挂在 body 上，React 组件重挂载时 state 会丢，
// 但 DOM 还在。用模块级变量保证「已打开」状态不丢。
const persistent = {
    frame: null,
    ready: false,
    open: false,
};

const FRAME_ID = "sketchup-director-frame";
// 导演台版本：随 DIRECTOR_BASE 的 commit 变化，用于检测旧 iframe 并强制重建。
const DIRECTOR_VERSION = (DIRECTOR_BASE.match(/@([0-9a-f]{7,40})/) || [])[1]?.slice(0, 8) || "dev";
const SCENE_KEY_PREFIX = "sketchup-director-scene:";

// 场景持久化：按节点 ID 隔离存 localStorage（画布域稳定可用，srcdoc 内不可用）。
function loadSceneForNode(nodeId) {
    try {
        const raw = localStorage.getItem(SCENE_KEY_PREFIX + nodeId);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveSceneForNode(nodeId, project) {
    try {
        localStorage.setItem(SCENE_KEY_PREFIX + nodeId, JSON.stringify(project));
    } catch {
        // 超出配额等忽略
    }
}

function getLiveFrame() {
    const el = document.getElementById(FRAME_ID);
    if (!(el instanceof HTMLIFrameElement)) return null;
    // 版本不匹配（导演台已更新）→ 视为失效，需要重建。
    if (el.dataset.directorVersion !== DIRECTOR_VERSION) return null;
    return el;
}

// 强制移除旧 iframe（含不同版本的）。
function removeStaleFrames() {
    // 只清理导演台自己的 iframe 与 overlay，避免误伤其他 iframe。
    document.querySelectorAll(`iframe#${FRAME_ID}`).forEach((el) => el.remove());
    const overlay = document.getElementById("sketchup-director-overlay");
    if (overlay) overlay.remove();
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
    const [autoSync, setAutoSync] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [directorOpen, setDirectorOpen] = React.useState(false);
    const [directorStatus, setDirectorStatus] = React.useState("");
    const [followSu, setFollowSu] = React.useState(false); // 导演台是否跟随 SU 视角（默认关，避免锁死）
    const followRef = React.useRef(false);
    followRef.current = followSu;
    // 反向控制（导演台 → SU）：默认关闭，避免与 SU 广播形成回环导致视角漂移。
    const [reverseSync, setReverseSync] = React.useState(false);
    const reverseRef = React.useRef(false);
    reverseRef.current = reverseSync;
    const [showGrid, setShowGrid] = React.useState(false);
    const showGridRef = React.useRef(false);
    showGridRef.current = showGrid;
    const [showGround, setShowGround] = React.useState(false);
    const showGroundRef = React.useRef(false);
    showGroundRef.current = showGround;
    // 模型缩放：默认 1（保持 SketchUp 真实比例）。只有确认比例不符时才手动调整。
    const [modelScale, setModelScale] = React.useState(1);
    const modelScaleRef = React.useRef(1);
    modelScaleRef.current = modelScale;

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
    const pendingExportRef = React.useRef(null);
    const exportTimeoutRef = React.useRef(null);
    const snapTimeoutRef = React.useRef(null);
    const camForwardTimerRef = React.useRef(null);
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
    let lastRenderAt = 0;
    const applyCamera = async (msg) => {
        if (!msg?.eye || !msg?.target) return;
        // 渲染节流：最多 20fps，避免占满主进程。
        const now = performance.now();
        if (now - lastRenderAt < 50) return;
        lastRenderAt = now;
        const s = await initScene();
        if (!s) return;
        const cam = s.camera;
        cam.position.set(msg.eye[0], msg.eye[1], msg.eye[2]);
        cam.up.set(0, 1, 0);
        cam.lookAt(msg.target[0], msg.target[1], msg.target[2]);
        const a = aspectRef.current;
        cam.fov = toVerticalFov(msg, a.w, a.h);
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
        if (!ws || ws.readyState !== 1) { setStatus("未连接 SketchUp"); return; }
        if (!silent) {
            setBusy(true);
            // 超时保护：8 秒没回来就解除 busy，避免按钮永久禁用。
            if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
            snapTimeoutRef.current = setTimeout(() => {
                setBusy(false);
                setStatus("截图超时（SketchUp 可能卡住了）");
            }, 8000);
        }
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

    // 手动把当前 SU 相机同步到导演台（不自动，避免打断操作）。
    const syncCameraNow = () => {
        const c = lastCameraRef.current;
        if (!c?.eye || !c?.target) {
            setStatus("还没有收到 SU 相机，请先在 SketchUp 里动一下视角");
            return;
        }
        if (!getLiveFrame()) {
            setStatus("请先打开导演台");
            return;
        }
        sendToDirector("storyai:director-desk-camera", {
            eye: c.eye, target: c.target, fov: c.vFov ?? c.fov, follow: false,
        });
        setStatus("已同步 SU 视角到导演台");
    };

    // ── 导演台（srcdoc 内联）──
    const sendToDirector = (type, payload) => {
        const frame = frameRef.current ?? getLiveFrame() ?? persistent.frame;
        frame?.contentWindow?.postMessage({ type, payload }, window.location.origin);
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
                scale: modelScaleRef.current,
                offset: m.offset || null,
            });
        }
        const c = lastCameraRef.current;
        if (c?.eye && c?.target) {
            sendToDirector("storyai:director-desk-camera", {
                eye: c.eye, target: c.target, fov: c.vFov ?? c.fov, follow: followRef.current,
            });
        }
        const bd = lastBackdropRef.current;
        if (bd) {
            sendToDirector("storyai:director-desk-backdrop", { dataUrl: bd, enabled: true });
        }
    };

    const openDirector = async () => {
        // 兜底：state 认为已打开，但 DOM 里实际没有 → 重置状态并重建。
        if (directorOpen && !document.getElementById("sketchup-director-overlay")) {
            setDirectorOpen(false);
        } else if (directorOpen) {
            return;
        }
        // 如果 DOM 里已有导演台（组件重挂载后 state 丢失），只同步状态。
        const existing = getLiveFrame();  // 已含版本校验
        if (existing) {
            frameRef.current = existing;
            persistent.frame = existing;
            persistent.ready = true;
            setDirectorOpen(true);
            setDirectorStatus(`导演台已打开（v${DIRECTOR_VERSION}）`);
            // 每次复用都重新应用场景设置，确保关闭网格/地面。
            sendToDirector("storyai:director-desk-scene", {
                showGrid: showGridRef.current,
                showGround: showGroundRef.current,
                showLabels: true,
            });
            return;
        }
        const origin = window.location.origin;
        // 先清理可能存在的旧 overlay / iframe（旧版本代码）。
        removeStaleFrames();
        const overlay = document.createElement("div");
        overlay.id = "sketchup-director-overlay";
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
                persistent.ready = true;
                loadingDiv.remove();
                setDirectorStatus("导演台就绪 ✅");
                // 把画布节点里保存的场景注入导演台（srcdoc 无 localStorage）。
                sendToDirector("storyai:director-desk-session", {
                    instanceId: `sketchup-${ctxRef.current.node.id}`,
                    theme: "dark",
                    project: loadSceneForNode(ctxRef.current.node.id),
                });
                // 关闭地面网格/地面，让底图画面更接近成品图。
                sendToDirector("storyai:director-desk-scene", {
                    showGrid: showGridRef.current,
                    showGround: showGroundRef.current,
                    showLabels: true,
                });
                // 强制进入「导演视角」，避免相机被机位锁定（会导致视角回弹）。
                sendToDirector("storyai:director-desk-view-mode", { mode: "director" });
                setTimeout(() => {
                    sendToDirector("storyai:director-desk-view-mode", { mode: "director" });
                }, 800);
                pushToDirector();
            } else if (type === "storyai:director-desk:response") {
                const p = event.data?.payload;
                if (p?.action === "export.frame" && p.requestId === pendingExportRef.current) {
                    pendingExportRef.current = null;
                    if (exportTimeoutRef.current) { clearTimeout(exportTimeoutRef.current); exportTimeoutRef.current = null; }
                    if (p.ok && p.data?.dataUrl) {
                        exportToCanvas(p.data.dataUrl, p.data.fileName || "导演台合成.png");
                        setStatus("已回传导演台合成画面到画布");
                    } else {
                        setError(`导出失败：${p.error?.message || "未知错误"}`);
                        setStatus("导出失败");
                    }
                    setBusy(false);
                }
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
                // 反向控制：导演台视角变化 → 回写 SketchUp 相机（默认关闭）。
                if (!reverseRef.current) return;
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
            const instanceId = `sketchup-${ctxRef.current.node.id}`;
            const frameHtml = await prepareDirectorFrame(origin, instanceId);
            // 只移除可能残留的旧 iframe，绝不能碰刚创建的 overlay。
            document.querySelectorAll(`iframe#${FRAME_ID}`).forEach((el) => el.remove());

            const frame = document.createElement("iframe");
            frame.id = FRAME_ID;
            frame.dataset.directorVersion = DIRECTOR_VERSION;
            frame.title = "3D导演台";
            frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
            frame.onerror = () => {
                loadingDiv.textContent = "导演台 iframe 加载失败";
                setDirectorStatus("iframe 加载失败");
            };
            frame.srcdoc = frameHtml;
            overlay.appendChild(frame);
            frameRef.current = frame;
            persistent.frame = frame;
            persistent.open = true;
        } catch (err) {
            loadingDiv.textContent = `导演台加载失败：${err instanceof Error ? err.message : String(err)}`;
            setDirectorStatus("加载失败");
        }
    };

    // 等待导演台就绪（轮询 persistent.ready）。
    const waitForDirectorReady = (timeoutMs = 20000) =>
        new Promise((resolve) => {
            if (persistent.ready || directorReadyRef.current) return resolve(true);
            const start = Date.now();
            const timer = setInterval(() => {
                if (persistent.ready || directorReadyRef.current) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 200);
        });

    const closeDirector = () => {
        directorReadyRef.current = false;
        persistent.ready = false;
        persistent.open = false;
        persistent.frame = null;
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
                const a = aspectRef.current;
                const normalized = { ...msg, vFov: toVerticalFov(msg, a.w, a.h) };
                lastCameraRef.current = normalized;
                setCamera(msg);
                void applyCamera(msg);
                scheduleSnapshot();
                // 相机只在「手动同步」时发送，避免自动刷新打断导演台操作。
            }
            return;
        }
        if (msg.type === "model") {
            if (msg.data) {
                const info = {
                    name: msg.name || "SketchUp模型", size: msg.size,
                    bbox: msg.bbox || null, base64: msg.data,
                    vertexCount: msg.vertex_count || 0,
                    offset: msg.offset || null,
                };
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
            if (snapTimeoutRef.current) { clearTimeout(snapTimeoutRef.current); snapTimeoutRef.current = null; }
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
    // 导出 SketchUp 原生截图（只有 SU 场景，不含导演台人物）。
    const exportHighRes = () => {
        if (!connected) { setStatus("请先连接 SketchUp"); return; }
        setStatus("正在导出 SketchUp 原生截图…");
        requestSnapshot(2048, false, false);
    };

    // 导出导演台合成画面（底图 + 模型 + 人物），走导演台 export.frame 协议，2048 宽。
    const exportDirectorFrame = async () => {
        setError("");
        try {
            // 1) 没有导演台就自动打开。
            if (!getLiveFrame()) {
                setStatus("正在打开导演台…");
                await openDirector();
            }
            // 2) 等就绪。
            setStatus("等待导演台就绪…");
            const ready = await waitForDirectorReady(20000);
            if (!ready) {
                setStatus("导演台未就绪");
                setError("导演台 20 秒内未就绪。请检查网络（导演台 JS 约 1.7MB）后重试。");
                return;
            }
            // 3) 切到「摄像机视角」并确保有 SK 机位（导出需要活动机位），导出后会切回导演视角。
            sendToDirector("storyai:director-desk-view-mode", { mode: "camera" });
            const cam = lastCameraRef.current;
            if (cam?.eye && cam?.target) {
                sendToDirector("storyai:director-desk-camera", {
                    eye: cam.eye, target: cam.target, fov: cam.vFov ?? cam.fov, follow: true,
                });
            }
            // 给导演台时间应用视角与渲染。
            await new Promise((r) => setTimeout(r, 900));

            // 4) 发送导出请求。
            const requestId = randomId("frame");
            pendingExportRef.current = requestId;
            setStatus("正在导出导演台合成画面（2048）…");
            sendToDirector("storyai:director-desk:request", {
                requestId,
                action: "export.frame",
                options: { fileName: "导演台合成.png", position: "current", quality: "2k" },
            });
            if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
            if (camForwardTimerRef.current) clearTimeout(camForwardTimerRef.current);
            exportTimeoutRef.current = setTimeout(() => {
                if (pendingExportRef.current === requestId) {
                    pendingExportRef.current = null;
                    sendToDirector("storyai:director-desk-view-mode", { mode: "director" });
                    setStatus("导出超时");
                    setError("导演台未在 20 秒内返回画面。请确认导演台处于「摄像机视角」且场景里已有机位。");
                }
            }, 20000);
        } catch (err) {
            setStatus("导出失败");
            setError(err instanceof Error ? err.message : String(err));
        }
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

    // 组件级消息监听：即使 openDirector 的闭包失效，也能收到导演台的导出响应。
    React.useEffect(() => {
        const handler = (event) => {
            const frame = getLiveFrame() ?? frameRef.current ?? persistent.frame;
            if (!frame || event.source !== frame.contentWindow) return;
            const type = event.data?.type;

            if (type === "storyai:director-desk-ready") {
                directorReadyRef.current = true;
                persistent.ready = true;
                setDirectorStatus("导演台就绪 ✅");
                return;
            }

            if (type === "storyai:director-desk:response") {
                const p = event.data?.payload;
                if (p?.action === "export.frame" && p.requestId === pendingExportRef.current) {
                    pendingExportRef.current = null;
                    if (exportTimeoutRef.current) {
                        clearTimeout(exportTimeoutRef.current);
                        exportTimeoutRef.current = null;
                    }
                    // 导出完成后切回导演视角，恢复自由操作。
                    sendToDirector("storyai:director-desk-view-mode", { mode: "director" });
                    if (p.ok && p.data?.dataUrl) {
                        exportToCanvas(p.data.dataUrl, p.data.fileName || "导演台合成.png");
                        setStatus("已回传导演台合成画面到画布");
                        setError("");
                    } else {
                        setError(`导出失败：${p.error?.message || "未知错误"}`);
                        setStatus("导出失败");
                    }
                }
                return;
            }

            if (type === "storyai:director-desk-project") {
                const proj = event.data?.payload?.project;
                if (proj && typeof proj === "object") {
                    saveSceneForNode(ctxRef.current.node.id, proj);
                }
                return;
            }

            if (type === "storyai:director-desk-captures-sent") {
                const caps = Array.isArray(event.data?.payload?.captures) ? event.data.payload.captures : [];
                caps.forEach((cap) => {
                    if (typeof cap?.dataUrl === "string" && cap.dataUrl.startsWith("data:image/")) {
                        exportToCanvas(cap.dataUrl, cap.fileName);
                    }
                });
                setDirectorStatus(`已回传 ${caps.length} 张导演台截图`);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, []);

    React.useEffect(() => {
        connect();
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
            if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
            if (camForwardTimerRef.current) clearTimeout(camForwardTimerRef.current);
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
        h("div", { style: { fontSize: 10, color: muted } },
            `导演台：${getLiveFrame() ? "已打开" : "未打开"}（v${DIRECTOR_VERSION}） ｜ ${directorStatus || "—"}`),
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
            h("button", { type: "button", style: buttonStyle, onClick: exportHighRes, disabled: !connected }, "导出 SU 原生图"),
        ),

        // 导演台入口 + 合成导出
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("button", { type: "button", style: { ...primaryStyle, background: "#7c5cff" }, onClick: openDirector, disabled: directorOpen }, directorOpen ? "导演台已打开" : "🎬 打开 3D 导演台"),
            h("button", { type: "button", style: { ...primaryStyle, background: "#2ea043" }, onClick: exportDirectorFrame }, "导出合成图(2048)"),
            h("button", {
                type: "button", style: buttonStyle,
                onClick: () => {
                    sendToDirector("storyai:director-desk-view-mode", { mode: "director" });
                    setTimeout(() => sendToDirector("storyai:director-desk-view-mode", { mode: "director" }), 120);
                    setTimeout(() => sendToDirector("storyai:director-desk-view-mode", { mode: "director" }), 400);
                    setStatus("已请求切换到导演视角");
                },
            }, "导演视角"),
            h("button", {
                type: "button", style: buttonStyle,
                onClick: () => sendToDirector("storyai:director-desk-view-mode", { mode: "camera" }),
            }, "摄像机视角"),
            h("button", { type: "button", style: buttonStyle, onClick: syncCameraNow }, "同步 SU 视角"),
            h("button", {
                type: "button", style: buttonStyle,
                onClick: () => {
                    removeStaleFrames();
                    frameRef.current = null;
                    persistent.frame = null;
                    persistent.ready = false;
                    setDirectorOpen(false);
                    setDirectorStatus("已卸载，请重新点「打开 3D 导演台」");
                },
            }, "重载导演台"),
            directorStatus ? h("span", { style: { fontSize: 11, color: muted } }, directorStatus) : null,
        ),
        // 模型缩放
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: muted } },
            h("span", null, "导演台模型缩放"),
            h("input", {
                type: "range", min: 0.1, max: 30, step: 0.1, value: modelScale,
                style: { flex: 1 },
                onChange: (e) => setModelScale(Number(e.target.value)),
            }),
            h("span", null, `${modelScale}×`),
            h("button", {
                type: "button", style: buttonStyle,
                onClick: () => {
                    if (directorReadyRef.current && lastModelRef.current) pushToDirector();
                },
            }, "应用"),
        ),
        // 同步开关
        h("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: muted } },
            h("label", { style: { display: "flex", alignItems: "center", gap: 5 } },
                h("input", { type: "checkbox", checked: followSu, onChange: (e) => setFollowSu(e.target.checked) }),
                "导演台跟随 SU 视角",
            ),
            h("label", { style: { display: "flex", alignItems: "center", gap: 5 } },
                h("input", { type: "checkbox", checked: reverseSync, onChange: (e) => setReverseSync(e.target.checked) }),
                "导演台视角回写 SU（默认关）",
            ),
            h("label", { style: { display: "flex", alignItems: "center", gap: 5 } },
                h("input", {
                    type: "checkbox", checked: showGrid, onChange: (e) => setShowGrid(e.target.checked),
                }),
                "显示地面网格",
            ),
            h("label", { style: { display: "flex", alignItems: "center", gap: 5 } },
                h("input", {
                    type: "checkbox", checked: showGround,
                    onChange: (e) => {
                        setShowGround(e.target.checked);
                        if (directorReadyRef.current) {
                            sendToDirector("storyai:director-desk-scene", { showGround: e.target.checked });
                        }
                    },
                }),
                "显示场景地面",
            ),
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
        // 诊断：尺寸 / 相机 / fov 方向，用于核对坐标系是否一致。
        h("div", { style: { fontSize: 10, color: muted, whiteSpace: "pre-wrap", borderTop: `1px dashed ${stroke}`, paddingTop: 6, lineHeight: 1.7 } },
            modelInfo?.bbox
                ? `模型尺寸(W×H×D)：${modelInfo.bbox.width.toFixed(3)} × ${modelInfo.bbox.height.toFixed(3)} × ${modelInfo.bbox.depth.toFixed(3)} 米\n顶点数：${modelInfo.vertexCount}\n`
                : "",
            camera
                ? `相机 eye(${camera.eye.map((n) => n.toFixed(2)).join(", ")})\n` +
                  `target(${camera.target.map((n) => n.toFixed(2)).join(", ")})\n` +
                  `fov ${camera.fov?.toFixed(2)}° · fov按${camera.fov_is_height === false ? "宽度" : "高度"}测量` +
                  ` → 垂直fov ${toVerticalFov(camera, aspect.w, aspect.h).toFixed(2)}°`
                : "",
        ),

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
