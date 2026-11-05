# SketchUp ↔ Infinite Canvas 同步插件

把 SketchUp 的相机视角与截图，实时同步到 Infinite Canvas（无限画布）节点，实现「取景框预览 + 高清导出」。无需传输模型几何、无需修改画布宿主后端。

## 架构

```
SketchUp 2026 (Ruby 插件)
  ├─ 本地 WebSocket 服务 (ws://127.0.0.1:8899)
  ├─ 实时推送相机参数 (eye/target/up/fov/aspect)
  ├─ 按需截图：小图(320) 预览 / 中图(1024) / 高清(2048)
  └─ 响应模型列表、场景列表

画布节点 (JS 插件)
  ├─ 连接 ws://127.0.0.1:8899
  ├─ 长宽比取景框 (16:9 / 4:3 / 1:1 / 9:16 / 3:4)
  ├─ 实时小图预览 / 静止中图 / 高清导出
  └─ 高清图回传画布图片节点
```

## 安装步骤

### 1. 安装 SketchUp Ruby 插件

把 `sketchup-canvas-sync.rb` 复制到 SketchUp 2026 的插件目录：

```
C:\Users\<你的用户名>\AppData\Roaming\SketchUp\SketchUp 2026\SketchUp\Plugins\
```

重启 SketchUp，菜单「扩展程序」里会出现：
- **CanvasSync：启动/停止同步服务**
- **CanvasSync：截图测试(320)**

### 2. 安装画布节点

在画布右上角「节点插件 → 第三方插件」粘贴：

```
https://cdn.jsdelivr.net/gh/wudidekongjv/-@main/dist/sketchup-sync.js
```

### 3. 使用

1. 在 SketchUp 里点「扩展程序 → CanvasSync：启动/停止同步服务」。
2. 画布创建「🏛️ SketchUp 同步」节点，会自动连接。
3. 选择取景长宽比，点「实时小图(320)」看流畅预览，或「导出高清(2048)」回传画布。

## 三级画质策略（减少卡顿）

| 级别 | 尺寸 | 时机 | 用途 |
|---|---|---|---|
| 实时小图 | 320px | 相机移动时高频更新 | 流畅预览，看大概形态 |
| 静止中图 | 1024px | 相机停止后 | 稳定预览 |
| 高清输出 | 2048px | 手动点「导出」 | 最终回传画布 |

## 技术说明

- **相机同步**：SketchUp `view.camera` 的 `eye/target/up/fov/aspect_ratio` 与 Three.js `PerspectiveCamera` 是同一套透视投影模型，可精确对应（本版画布侧先显示参数，不渲染 3D）。
- **截图对位**：所有截图都由 SketchUp 按「同一相机 + 同一长宽比」输出，天然对齐，无需投影变换。
- **通信**：SketchUp Ruby 用 `TCPServer` + `UI.start_timer` 驱动 WebSocket 服务（单线程非阻塞），画布用 `WebSocket` 连接。

## 已知限制

- SketchUp 的 `view.write_image` 会短暂阻塞主线程，截图越大越卡（这是三级画质策略存在的原因）。
- 需要 SketchUp 和画布在同一台机器上（本地 `127.0.0.1`）。
