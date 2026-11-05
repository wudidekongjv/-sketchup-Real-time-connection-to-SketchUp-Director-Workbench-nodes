# frozen_string_literal: true
# CanvasSync 实际逻辑 —— 由主文件 sketchup-canvas-sync.rb 加载。
# 功能：
#   1) 选中模型 → 导出 glb → 通过 WebSocket 发给画布
#   2) 相机参数实时同步（eye/target/up/fov/aspect，英寸→米）
#   3) 截图按需输出
# 通信：本地 WebSocket 服务（127.0.0.1:8899）

require 'sketchup.rb'
require 'socket'
require 'json'
require 'base64'
require 'digest'
require 'thread'

module SketchUpCanvasSync
  HOST = '127.0.0.1'
  PORT = 8899
  WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  INCH_TO_METER = 0.0254
  FLOAT_PACK = 'e'          # 单精度浮点（小端）
  UINT32_PACK = 'V'         # 32位无符号（小端）
  UINT16_PACK = 'v'         # 16位无符号（小端）

  @server = nil
  @clients = []
  @mutex = Mutex.new
  @running = false
  @timer_id = nil
  @camera_timer_id = nil
  @aspect_w = 16
  @aspect_h = 9
  @last_model_offset = { cx: 0.0, cz: 0.0, min_y: 0.0 }
  @last_model_size = { width: 0.0, height: 0.0, depth: 0.0 }
  @last_vertex_count = 0
  @last_raw_range = { xmin: 0.0, xmax: 0.0, ymin: 0.0, ymax: 0.0, zmin: 0.0, zmax: 0.0 }
  @suppress_broadcast_until = nil

  class << self
    def running?
      @running
    end

    def start
      return if @running
      begin
        @server = TCPServer.new(HOST, PORT)
        @running = true
        @timer_id = UI.start_timer(0.05, true) { tick }
        @camera_timer_id = UI.start_timer(0.3, true) { broadcast_camera }
        puts '[CanvasSync] 服务已启动 ws://127.0.0.1:8899'
      rescue => e
        @server = nil
        @running = false
        UI.messagebox("CanvasSync 启动失败：#{e.class}: #{e.message}")
      end
    end

    def stop
      @running = false
      UI.stop_timer(@timer_id) if @timer_id
      UI.stop_timer(@camera_timer_id) if @camera_timer_id
      @timer_id = nil
      @camera_timer_id = nil
      @mutex.synchronize do
        @clients.each { |c| c[:socket].close rescue nil }
        @clients.clear
      end
      @server.close rescue nil
      @server = nil
      puts '[CanvasSync] 服务已停止'
    end

    def toggle
      running? ? stop : start
    end

    # ── 主循环 ──
    def tick
      return unless @running
      accept_clients
      read_clients
    end

    def accept_clients
      return unless @server
      loop do
        sock = begin
          @server.accept_nonblock
        rescue IO::WaitReadable, Errno::EAGAIN, Errno::EWOULDBLOCK
          break
        rescue => e
          break
        end
        sock.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
        @mutex.synchronize do
          @clients << { socket: sock, rbuf: ''.b, handshaken: false }
        end
        puts "[CanvasSync] 客户端连接：#{sock.peeraddr[3]}"
      end
    end

    def read_clients
      @mutex.synchronize do
        @clients.each do |c|
          sock = c[:socket]
          begin
            chunk = sock.read_nonblock(65536)
            c[:rbuf] << chunk.b
            process_buffer(c)
          rescue IO::WaitReadable, Errno::EAGAIN, Errno::EWOULDBLOCK
            # 暂无数据
          rescue => e
            remove_client(c)
          end
        end
      end
    end

    def process_buffer(c)
      sock = c[:socket]
      unless c[:handshaken]
        idx = c[:rbuf].index("\r\n\r\n")
        return unless idx
        header = c[:rbuf][0, idx + 4]
        c[:rbuf] = c[:rbuf][(idx + 4)..-1] || ''.b
        do_handshake(sock, header)
        c[:handshaken] = true
      end
      loop do
        frame = extract_frame(c[:rbuf])
        break unless frame
        dispatch(sock, frame[0], frame[1])
      end
    end

    def do_handshake(sock, header)
      key = header[/Sec-WebSocket-Key:\s*([^\r\n]+)/i, 1]
      raise 'no websocket key' unless key
      accept = Base64.strict_encode64(Digest::SHA1.digest(key.strip + WS_GUID))
      response = "HTTP/1.1 101 Switching Protocols\r\n" \
                 "Upgrade: websocket\r\n" \
                 "Connection: Upgrade\r\n" \
                 "Sec-WebSocket-Accept: #{accept}\r\n\r\n"
      sock.write(response)
      puts '[CanvasSync] WebSocket 握手完成'
    end

    def extract_frame(buf)
      return nil if buf.bytesize < 2
      b0 = buf.getbyte(0)
      b1 = buf.getbyte(1)
      opcode = b0 & 0x0F
      masked = (b1 & 0x80) != 0
      len = b1 & 0x7F
      offset = 2
      if len == 126
        return nil if buf.bytesize < 4
        len = buf.byteslice(2, 2).unpack1('n')
        offset = 4
      elsif len == 127
        return nil if buf.bytesize < 10
        len = buf.byteslice(2, 8).unpack1('Q>')
        offset = 10
      end
      mask = nil
      if masked
        return nil if buf.bytesize < offset + 4
        mask = buf.byteslice(offset, 4)
        offset += 4
      end
      return nil if buf.bytesize < offset + len
      payload = buf.byteslice(offset, len)
      payload = unmask(payload, mask) if masked && mask
      rest = buf.byteslice(offset + len, buf.bytesize - offset - len) || ''.b
      buf.replace(rest)
      [opcode, payload]
    end

    def unmask(payload, mask)
      bytes = payload.bytes
      bytes.each_with_index.map { |b, i| (b ^ mask.getbyte(i % 4)) }.pack('C*')
    end

    def dispatch(sock, opcode, payload)
      case opcode
      when 0x8 then remove_client_by_socket(sock)
      when 0x9 then send_frame(sock, 0x8A, payload)
      when 0x1, 0x0 then handle_command(sock, payload.force_encoding('UTF-8'))
      end
    end

    def handle_command(sock, text)
      msg = JSON.parse(text) rescue {}
      case msg['type']
      when 'get_camera'       then send_json(sock, camera_payload)
      when 'snapshot'         then send_snapshot(sock, msg['width'].to_i, msg['hide_selection'] == true)
      when 'set_camera'       then set_camera_from_host(msg)
      when 'send_selection'   then send_selection_glb(sock)
      when 'set_aspect'
        @aspect_w = msg['w'].to_i if msg['w'].to_i > 0
        @aspect_h = msg['h'].to_i if msg['h'].to_i > 0
      end
    rescue => e
      puts "[CanvasSync] 命令处理失败：#{e.class}: #{e.message}"
      send_json(sock, { type: 'error', message: "#{e.class}: #{e.message}" }) rescue nil
    end

    # ── 相机 ──
    # 模型导出时做了 Z-up→Y-up 转换 + X/Z 居中 + Y 贴地，
    # 相机必须用同样的变换，才能和模型对齐。
    def sketchup_to_gltf(x, y, z)
      [x, z, -y]
    end

    def camera_payload
      model = Sketchup.active_model
      return { type: 'camera', error: 'no_model' } unless model
      cam = model.active_view.camera
      offset = @last_model_offset || { cx: 0.0, cz: 0.0, min_y: 0.0 }

      eye = transform_point(cam.eye, offset)
      target = transform_point(cam.target, offset)
      up = cam.up

      {
        type: 'camera',
        eye: eye,
        target: target,
        up: [up.x.to_f, up.y.to_f, up.z.to_f],
        fov: cam.fov.to_f,
        # SketchUp 的 fov 可能是按「高度」或「宽度」测量，前端需据此换算垂直 fov。
        fov_is_height: cam.respond_to?(:fov_is_height?) ? cam.fov_is_height? : true,
        aspect_ratio: cam.aspect_ratio.to_f,
        perspective: cam.perspective?,
      }
    rescue => e
      { type: 'camera', error: e.message }
    end

    # 把一个 SketchUp 点按「轴转换 + 模型偏移 + 英寸→米」变成 glTF 坐标。
    def transform_point(pt, offset)
      gx, gy, gz = sketchup_to_gltf(pt.x.to_f, pt.y.to_f, pt.z.to_f)
      [
        ((gx - offset[:cx]) * INCH_TO_METER).round(4),
        ((gy - offset[:min_y]) * INCH_TO_METER).round(4),
        ((gz - offset[:cz]) * INCH_TO_METER).round(4),
      ]
    end

    # 反向控制：把 glTF 坐标转回 SketchUp 坐标，设置当前相机。
    # 逆变换：SU.x = g.x, SU.y = -g.z, SU.z = g.y；米 → 英寸。
    def set_camera_from_host(msg)
      model = Sketchup.active_model
      return unless model
      eye = msg['eye']
      target = msg['target']
      return unless eye && target && eye.length >= 3 && target.length >= 3

      view = model.active_view
      cam = view.camera
      inv = 1.0 / INCH_TO_METER
      eye_su = Geom::Point3d.new(eye[0].to_f * inv, -eye[2].to_f * inv, eye[1].to_f * inv)
      target_su = Geom::Point3d.new(target[0].to_f * inv, -target[2].to_f * inv, target[1].to_f * inv)
      up = Geom::Vector3d.new(0, 0, 1)

      # 抑制本轮广播，避免回环。
      @suppress_broadcast_until = Time.now + 0.6
      cam.set(eye_su, target_su, up)
      fov = msg['fov']
      cam.fov = fov.to_f if fov && fov.to_f > 0 && cam.perspective?
      view.invalidate
    rescue => e
      puts "[CanvasSync] set_camera 失败：#{e.class}: #{e.message}"
    end

    def broadcast_camera
      return unless @running
      return if @clients.empty?
      # 反向控制期间抑制广播，避免 SU↔导演台 死循环。
      if @suppress_broadcast_until && Time.now < @suppress_broadcast_until
        return
      end
      payload = JSON.generate(camera_payload)
      @mutex.synchronize do
        @clients.each { |c| send_frame(c[:socket], 0x81, payload) if c[:handshaken] }
      end
    rescue => e
      # 忽略广播错误
    end

    # ── glb 导出 ──
    def send_selection_glb(sock)
      model = Sketchup.active_model
      sel = model.selection
      if sel.empty?
        send_json(sock, { type: 'model', error: 'no_selection' })
        return
      end

      # 收集所有选中实体里的面（含组件实例）。
      faces = []
      sel.each do |entity|
        collect_faces(entity, Geom::Transformation.new, faces)
      end

      if faces.empty?
        send_json(sock, { type: 'model', error: 'no_faces' })
        return
      end

      glb = build_glb(faces)
      b64 = Base64.strict_encode64(glb)
      size_info = @last_model_size
      send_json(sock, {
        type: 'model',
        name: model.name || 'SketchUp模型',
        mime: 'model/gltf-binary',
        size: glb.bytesize,
        data: b64,
        bbox: size_info,
        unit: 'meter',
        vertex_count: @last_vertex_count,
      })
      puts "[CanvasSync] 导出 #{faces.length} 面 / #{@last_vertex_count} 顶点" \
           " | 尺寸 #{size_info[:width].round(3)}×#{size_info[:height].round(3)}×#{size_info[:depth].round(3)} 米" \
           " | 原始世界坐标范围 X[#{@last_raw_range[:xmin].round(1)}, #{@last_raw_range[:xmax].round(1)}] 英寸"
    rescue => e
      puts "[CanvasSync] glb 导出失败：#{e.class}: #{e.message}"
      send_json(sock, { type: 'model', error: e.message })
    end

    def collect_faces(entity, transform, out)
      if entity.is_a?(Sketchup::Face)
        out << [entity, transform]
      elsif entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance)
        t = transform * entity.transformation
        entity.definition.entities.each do |e|
          collect_faces(e, t, out)
        end
      end
    end

    def build_glb(faces)
      # 第一步：收集所有面的顶点（SketchUp 世界坐标，英寸）。
      raw_positions = []   # 每顶点 [x,y,z]（英寸，SketchUp Z-up）
      indices = []         # 三角形索引
      colors = []          # 每顶点颜色
      vertex_map = {}

      faces.each do |face, transform|
        mesh = face.mesh(Geom::PolygonMesh::MESH_POINTS)
        color = face_color(face)
        mesh.polygons.each do |poly|
          triangulate(poly).each do |raw_idx|
            # SketchUp 的负索引表示隐藏边，取绝对值才是顶点索引。
            idx = raw_idx.abs
            pt = mesh.point_at(idx)
            p = pt.transform(transform)
            key = [p.x.round(4), p.y.round(4), p.z.round(4)]
            vi = vertex_map[key]
            unless vi
              vi = raw_positions.length
              vertex_map[key] = vi
              raw_positions << [p.x.to_f, p.y.to_f, p.z.to_f]
              colors << color[0] << color[1] << color[2]
            end
            indices << vi
          end
        end
      end

      return nil if raw_positions.empty?

      # 第二步：坐标轴转换 + 英寸→米。
      # SketchUp 是 Z-up（X右 Y前 Z上），glTF/Three.js 是 Y-up（X右 Y上 Z朝观察者）。
      # 映射：glTF.x = SU.x, glTF.y = SU.z, glTF.z = -SU.y
      # 重要：不做居中/平移，保留 SketchUp 原始世界坐标，这样和 SU 相机截图才能严丝合缝对齐。
      converted = raw_positions.map { |(x, y, z)| [x, z, -y] }

      xs = converted.map { |v| v[0] }
      ys = converted.map { |v| v[1] }
      zs = converted.map { |v| v[2] }

      positions = []
      converted.each do |(x, y, z)|
        positions << x * INCH_TO_METER
        positions << y * INCH_TO_METER
        positions << z * INCH_TO_METER
      end

      # 偏移量归零（保留原始坐标，不居中）。
      @last_model_offset = { cx: 0.0, cz: 0.0, min_y: 0.0 }
      @last_model_size = {
        width: (xs.max - xs.min) * INCH_TO_METER,
        height: (ys.max - ys.min) * INCH_TO_METER,
        depth: (zs.max - zs.min) * INCH_TO_METER,
      }
      @last_vertex_count = raw_positions.length
      @last_raw_range = { xmin: xs.min, xmax: xs.max, ymin: ys.min, ymax: ys.max, zmin: zs.min, zmax: zs.max }

      build_glb_binary(positions, indices, colors)
    end

    def face_color(face)
      mat = face.material || face.back_material
      if mat && mat.color
        c = mat.color
        return [(c.red / 255.0), (c.green / 255.0), (c.blue / 255.0)]
      end
      [0.8, 0.8, 0.8]
    end

    # 简单三角化（扇形）。
    def triangulate(poly)
      return [] if poly.length < 3
      tris = []
      (1..(poly.length - 2)).each do |i|
        tris << poly[0] << poly[i] << poly[i + 1]
      end
      tris
    end

    def build_glb_binary(positions, indices, colors)
      # 组装 glTF 2.0 的 JSON。
      # buffer 布局：[positions(12字节/顶点)][indices(4字节/索引)][colors(12字节/顶点)]
      pos_count = positions.length / 3
      idx_count = indices.length
      col_count = colors.length / 3

      pos_byte_len = positions.length * 4
      idx_byte_len = idx_count * 4
      col_byte_len = colors.length * 4
      total_bin = pos_byte_len + idx_byte_len + col_byte_len

      # 对齐到 4 字节。
      total_bin = (total_bin + 3) & ~3

      json = {
        asset: { version: '2.0', generator: 'CanvasSync' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'SketchUpModel' }],
        meshes: [{
          primitives: [{
            attributes: {
              POSITION: 0,
              COLOR_0: 2
            },
            indices: 1,
            mode: 4
          }]
        }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: pos_count, type: 'VEC3', min: min3(positions), max: max3(positions) },
          { bufferView: 1, componentType: 5125, count: idx_count, type: 'SCALAR' },
          { bufferView: 2, componentType: 5126, count: col_count, type: 'VEC3' }
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: pos_byte_len, target: 34962 },
          { buffer: 0, byteOffset: pos_byte_len, byteLength: idx_byte_len, target: 34963 },
          { buffer: 0, byteOffset: pos_byte_len + idx_byte_len, byteLength: col_byte_len, target: 34962 }
        ],
        buffers: [{ byteLength: total_bin }]
      }

      # 组装二进制 buffer。
      bin = String.new(capacity: total_bin, encoding: 'BINARY')
      positions.each { |v| bin << [v].pack(FLOAT_PACK) }
      indices.each { |i| bin << [i].pack(UINT32_PACK) }
      colors.each { |v| bin << [v].pack(FLOAT_PACK) }
      # 填充到 4 字节对齐。
      while bin.bytesize < total_bin
        bin << "\x00".b
      end

      json_str = JSON.generate(json)
      json_bytes = json_str.bytes
      # JSON chunk 也要 4 字节对齐（补空格）。
      while json_bytes.length % 4 != 0
        json_bytes << 0x20
      end

      # glb header + chunks。
      glb = String.new(encoding: 'BINARY')
      glb << [0x46546C67].pack(UINT32_PACK)      # magic 'glTF'
      glb << [2].pack(UINT32_PACK)               # version 2
      glb << [12 + 8 + json_bytes.length + 8 + total_bin].pack(UINT32_PACK)  # total length

      glb << [json_bytes.length].pack(UINT32_PACK)   # JSON chunk length
      glb << [0x4E4F534A].pack(UINT32_PACK)          # chunk type 'JSON'
      glb << json_bytes.pack('C*')

      glb << [total_bin].pack(UINT32_PACK)           # BIN chunk length
      glb << [0x004E4942].pack(UINT32_PACK)          # chunk type 'BIN\0'
      glb << bin

      glb
    end

    def min3(arr)
      (0...arr.length/3).map { |i| [arr[i*3], arr[i*3+1], arr[i*3+2]] }.transpose.map(&:min)
    end

    def max3(arr)
      (0...arr.length/3).map { |i| [arr[i*3], arr[i*3+1], arr[i*3+2]] }.transpose.map(&:max)
    end

    # ── 截图 ──
    # hide_selection=true 时，截图前隐藏选中实体（分层渲染：截图只含背景，3D 层只含选中模型）。
    def send_snapshot(sock, width, hide_selection)
      width = 320 if width <= 0
      model = Sketchup.active_model
      unless model
        send_json(sock, { type: 'snapshot', error: 'no_model' })
        return
      end
      view = model.active_view
      height = (width * @aspect_h.to_f / @aspect_w.to_f).round

      hidden = []
      if hide_selection
        begin
          model.selection.each do |entity|
            next unless entity.respond_to?(:visible=)
            hidden << [entity, entity.visible?]
            entity.visible = false
          end
          view.refresh
        rescue => e
          puts "[CanvasSync] 隐藏选中失败：#{e.message}"
        end
      end

      begin
        path = File.join(Dir.tmpdir, "canvas_sync_snap_#{width}.png")
        ok = view.write_image(path, width, height)
        unless ok && File.exist?(path)
          send_json(sock, { type: 'snapshot', error: 'write_image failed' })
          return
        end
        data = File.binread(path)
        File.delete(path) rescue nil
        b64 = Base64.strict_encode64(data)
        send_json(sock, {
          type: 'snapshot',
          width: width,
          height: height,
          mime: 'image/png',
          hide_selection: hide_selection,
          data: "data:image/png;base64,#{b64}",
        })
      ensure
        # 无论成功失败，恢复可见性。
        hidden.each { |(entity, was_visible)| entity.visible = was_visible rescue nil }
        view.refresh if hide_selection
      end
    rescue => e
      send_json(sock, { type: 'snapshot', error: e.message })
    end

    # ── 发送 ──
    def send_json(sock, obj)
      send_frame(sock, 0x81, JSON.generate(obj))
    end

    def send_frame(sock, opcode, payload)
      payload = payload.dup.force_encoding('BINARY')
      len = payload.bytesize
      header = if len < 126
        [opcode, len].pack('CC')
      elsif len < 65536
        [opcode, 126, len].pack('CCn')
      else
        [opcode, 127, len].pack('CCQ>')
      end
      sock.write(header + payload)
    rescue => e
      remove_client_by_socket(sock)
    end

    def remove_client_by_socket(sock)
      entry = @clients.find { |c| c[:socket] == sock }
      remove_client(entry) if entry
    end

    def remove_client(entry)
      @clients.delete(entry)
      entry[:socket].close rescue nil
      puts '[CanvasSync] 客户端断开'
    end
  end

  # ── 菜单 ──
  unless file_loaded?(__FILE__)
    menu = UI.menu('Plugins').add_submenu('CanvasSync')
    menu.add_item('启动/停止同步服务') { toggle }
    menu.add_item('发送选中模型') {
      start unless running?
      sleep 0.2
      sock = @clients.find { |c| c[:handshaken] }&.dig(:socket)
      if sock
        send_selection_glb(sock)
      else
        UI.messagebox('没有连接的画布客户端。请先在画布创建 SketchUp 同步节点。')
      end
    }
    file_loaded(__FILE__)
  end
end
