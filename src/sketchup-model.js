// Infinite Canvas SketchUp 模型同步节点 —— Three.js 场景。
// 连接 ws://127.0.0.1:8899，接收 SketchUp 导出的 glb 模型 + 实时相机，
// 用 Three.js 渲染 3D 场景，截图回传画布（供 AI 生图保持场景一致）。

const WS_URL = "ws://127.0.0.1:8899";
const THREE_BASE = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const GLTFLOADER_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";

let threePromise = null;
async function loadThree() {
    if (!threePromise) {
        threePromise = import(/* @vite-ignore */ THREE_BASE);
    }
    return threePromise;
}

let gltfLoaderPromise = null;
async function loadGLTFLoader() {
    if (!gltfLoaderPromise) {
        gltfLoaderPromise = import(/* @vite-ignore */ GLTFLOADER_URL).then(async (mod) => {
            const THREE = await loadThree();
            return mod.GLTFLoader || mod.default;
        });
    }
    return gltfLoaderPromise;
}

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function SketchUpModelContent({ ctx, React }) {
    const h = React.createElement;

    const [connected, setConnected] = React.useState(false);
    const [status, setStatus] = React.useState("未连接");
    const [error, setError] = React.useState("");
    const [modelInfo, setModelInfo] = React.useState(null); // { name, size }
    const [cameraInfo, setCameraInfo] = React.useState(null);

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const wsRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const sceneRef = React.useRef(null); // { renderer, scene, camera, model }
    const pendingCameraRef = React.useRef(null);
    const currentDataUrlRef = React.useRef(null);

    // 初始化 Three.js 场景。
    const initScene = async () => {
        if (sceneRef.current) return sceneRef.current;
        const THREE = await loadThree();
        const canvas = canvasRef.current;
        if (!canvas) return null;

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
        const w = canvas.clientWidth || 400;
        const hgt = canvas.clientHeight || 300;
        renderer.setSize(w, hgt, false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x2a2a2a);
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const dir = new THREE.DirectionalLight(0xffffff, 1.2);
        dir.position.set(5, 10, 7);
        scene.add(dir);

        const camera = new THREE.PerspectiveCamera(60, w / hgt, 0.01, 1000);
        camera.position.set(5, 5, 5);
        camera.lookAt(0, 0, 0);

        sceneRef.current = { renderer, scene, camera, model: null };
        render(sceneRef.current);
        return sceneRef.current;
    };

    const render = (s) => {
        if (!s) return;
        s.renderer.render(s.scene, s.camera);
    };

    const connect = () => {
        setError("");
        setStatus("连接中…");
        try {
            const ws = new WebSocket(WS_URL);
            wsRef.current = ws;
            ws.binaryType = "arraybuffer";
            ws.onopen = () => {
                setConnected(true);
                setStatus("已连接 SketchUp ✅");
                ws.send(JSON.stringify({ type: "get_camera" }));
            };
            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    await handleMessage(msg);
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

    const handleMessage = async (msg) => {
        switch (msg.type) {
            case "camera":
                if (msg.eye) {
                    pendingCameraRef.current = msg;
                    setCameraInfo(msg);
                    applyCamera(msg);
                }
                break;
            case "model":
                if (msg.data) {
                    setStatus(`加载模型中…（${(msg.size / 1024 / 1024).toFixed(2)} MB）`);
                    await loadModel(msg.data);
                    setModelInfo({ name: msg.name, size: msg.size });
                    setStatus("模型已加载 ✅");
                } else if (msg.error) {
                    setError(`模型导出失败：${msg.error}`);
                }
                break;
            case "error":
                setError(msg.message || "未知错误");
                break;
        }
    };

    const applyCamera = async (msg) => {
        const s = await initScene();
        if (!s || !msg.eye) return;
        const THREE = await loadThree();
        s.camera.position.set(msg.eye[0], msg.eye[1], msg.eye[2]);
        if (msg.target) s.camera.lookAt(msg.target[0], msg.target[1], msg.target[2]);
        if (msg.up) s.camera.up.set(msg.up[0], msg.up[1], msg.up[2]);
        if (msg.fov) s.camera.fov = msg.fov;
        if (msg.aspect_ratio && msg.aspect_ratio > 0) s.camera.aspect = msg.aspect_ratio;
        s.camera.updateProjectionMatrix();
        render(s);
    };

    const loadModel = async (base64) => {
        const s = await initScene();
        if (!s) return;
        const THREE = await loadThree();
        const GLTFLoader = await loadGLTFLoader();

        // base64 → arraybuffer
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const loader = new GLTFLoader();
        const gltf = await new Promise((resolve, reject) => {
            loader.parse(bytes.buffer, "", resolve, reject);
        });

        // 移除旧模型。
        if (s.model) {
            s.scene.remove(s.model);
            s.model.traverse((obj) => { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose(); });
        }
        s.model = gltf.scene;

        // 计算包围盒，调整相机视野。
        const box = new THREE.Box3().setFromObject(s.model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        s.model.position.sub(center);
        s.scene.add(s.model);

        render(s);
    };

    // 截图 → dataURL → 回传画布。
    const captureToCanvas = async () => {
        const s = await initScene();
        if (!s) return;
        const dataUrl = s.renderer.domElement.toDataURL("image/png");
        currentDataUrlRef.current = dataUrl;
        setStatus("已截图，可回传画布");
    };

    const sendToCanvas = () => {
        const dataUrl = currentDataUrlRef.current;
        if (!dataUrl) { setStatus("请先截图"); return; }
        const node = ctxRef.current.node;
        const id = randomId("su-model");
        ctxRef.current.applyOps([
            {
                type: "add_node", id, nodeType: "image", title: "SketchUp场景截图.png",
                x: node.position.x + node.width + 96, y: node.position.y,
                width: 400, height: 300,
                metadata: { content: dataUrl, status: "success", naturalWidth: 800, naturalHeight: 600, mimeType: "image/png" },
            },
            { type: "connect_nodes", fromNodeId: node.id, toNodeId: id },
        ]);
        setStatus("已回传场景截图到画布");
    };

    React.useEffect(() => {
        connect();
        return () => { if (wsRef.current) wsRef.current.close(); };
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
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "SketchUp 模型场景"),
        ),
        h("div", { style: { fontSize: 12 } }, `状态：${status}`),
        error ? h("div", { style: { color: "#ef9a9a", fontSize: 11, whiteSpace: "pre-wrap" } }, error) : null,
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { type: "button", style: primaryStyle, onClick: connect, disabled: connected }, connected ? "已连接" : "连接 SketchUp"),
            h("button", { type: "button", style: buttonStyle, onClick: captureToCanvas }, "截图预览"),
            h("button", { type: "button", style: primaryStyle, onClick: sendToCanvas }, "回传画布"),
        ),
        // Three.js 渲染画布
        h("canvas", {
            ref: canvasRef,
            style: { width: "100%", aspectRatio: "16/9", borderRadius: 8, border: `1px solid ${stroke}`, background: "#2a2a2a", display: "block" },
            onMouseDown: (e) => e.stopPropagation(),
        }),
        modelInfo
            ? h("div", { style: { fontSize: 11, color: muted } }, `模型：${modelInfo.name}（${(modelInfo.size / 1024).toFixed(1)} KB）`)
            : h("div", { style: { fontSize: 11, color: muted } }, "请在 SketchUp 选中模型，点「CanvasSync → 发送选中模型」"),
        cameraInfo
            ? h("div", { style: { fontSize: 11, color: muted, whiteSpace: "pre-wrap" } },
                `相机 eye(${cameraInfo.eye.map((n) => n.toFixed(2)).join(", ")}) fov ${cameraInfo.fov?.toFixed(1)}°`,
            )
            : null,
        h("div", { style: { fontSize: 10, color: muted, borderTop: `1px solid ${stroke}`, paddingTop: 6 } }, "提示：相机实时跟随 SketchUp；模型需手动发送。截图可回传画布作为 AI 生图参考。"),
    );
}

export default function createSketchUpModelPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "sketchup-model",
        name: "SketchUp 模型场景",
        version: "0.1.0",
        minAppVersion: "0.12.0",
        description: "导入 SketchUp 选中模型，用 Three.js 渲染，相机实时同步，截图回传画布保持场景一致。",
        nodes: [
            {
                type: "sketchup:model",
                title: "SketchUp 模型场景",
                icon: "🏛️",
                description: "导入 SketchUp 模型 + 相机同步 + 截图回传",
                defaultSize: { width: 400, height: 560 },
                defaultMetadata: {},
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => SketchUpModelContent({ ...props, React }),
            },
        ],
    };
}
