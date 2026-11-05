# ============================================================
# SketchUp ↔ Infinite Canvas 同步插件
# 功能：把 SketchUp 当前相机的 eye/target/up/fov/aspect 实时推送给画布，
#       并按需输出截图（小图预览 / 中图 / 高清图）。
# 通信：本地 WebSocket 服务，监听 127.0.0.1:8899。
# 安装：把本文件复制到 SketchUp 的 Plugins 目录（见 README）。
# ============================================================

require 'sketchup.rb'
require 'extensions.rb'
require 'socket'
require 'json'
require 'base64'
require 'digest'

module SketchUpCanvasSync
  HOST = '127.0.0.1'
  PORT = 8899

  @server = nil
  @clients = []      # 已连接的客户端 socket
  @running = false
  @timer = nil
  @broadcast_seq = 0

  # 当前「输出宽高比」（由画布节点设定），默认 16:9。
  @aspect_w = 16
  @aspect_h = 9

  def self.running?
    @running
  end

  # 启动 WebSocket 服务。
  def self.start
    return if @running
    begin
      @server = TCPServer.new(HOST, PORT)
      @running = true
      # 定时驱动：每 50ms 检查新连接 + 读取数据 + 推送相机。
      @timer = UI.start_timer(0.05, true) { tick }
      puts "[CanvasSync] 服务已启动 ws://#{HOST}:#{PORT}"
    rescue => e
      UI.messagebox("CanvasSync 启动失败：#{e.message}")
      @server = nil
      @running = false
    end
  end

  def self.stop
    @running = false
    UI.stop_timer(@timer) if @timer
    @timer = nil
    @clients.each { |c| c.close rescue nil }
    @clients.clear
    @server.close rescue nil
    @server = nil
    puts "[CanvasSync] 服务已停止"
  end

  def self.toggle
    running? ? stop : start
  end

  # 主循环（每 50ms 一次）。
  def self.tick
    return unless @running
    accept_clients
    read_messages
    broadcast_camera
  end

  # 接受新连接。
  def self.accept_clients
    return unless @server
    begin
      loop do
        client = @server.accept_nonblock rescue break
        client.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
        @clients << client
        puts "[CanvasSync] 客户端连接：#{client.peeraddr[3]}"
      end
    rescue IO::WaitReadable, Errno::EAGAIN
      # 没有更多连接
    end
  end

  # 读取客户端消息（处理 WebSocket 握手 + 帧）。
  def self.read_messages
    @clients.dup.each do |client|
      begin
        data = client.read_nonblock(65536) rescue nil
        if data.nil? || data.empty?
          # 可能断开
        else
          handle_data(client, data)
        end
      rescue IO::WaitReadable, Errno::EAGAIN
        # 暂无数据
      rescue => e
        remove_client(client)
      end
    end
  end

  def self.handle_data(client, data)
    # 握手检测：HTTP Upgrade 请求。
    if data.include?("Sec-WebSocket-Key")
      do_handshake(client, data)
    else
      # WebSocket 帧解析。
      parse_frames(client, data)
    end
  end

  # 完成 WebSocket 握手。
  def self.do_handshake(client, data)
    key = data[/Sec-WebSocket-Key:\s*(.+)\r\n/i, 1]
    return unless key
    accept = Base64.strict_encode64(Digest::SHA1.digest(key.strip + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
    response = "HTTP/1.1 101 Switching Protocols\r\n" \
               "Upgrade: websocket\r\n" \
               "Connection: Upgrade\r\n" \
               "Sec-WebSocket-Accept: #{accept}\r\n\r\n"
    client.write(response)
    # 标记为已握手。
    client.instance_variable_set(:@ws_ready, true)
    puts "[CanvasSync] WebSocket 握手完成"
  end

  # 解析 WebSocket 帧（仅处理文本帧 + 关闭帧）。
  def self.parse_frames(client, data)
    # 简化：假设一次收到完整一帧（小消息场景够用）。
    return unless data.bytesize >= 2
    first = data.getbyte(0)
    second = data.getbyte(1)
    opcode = first & 0x0F
    masked = (second & 0x80) != 0
    len = second & 0x7F
    offset = 2
    if len == 126
      len = data.byteslice(2, 2).unpack1('n')
      offset = 4
    elsif len == 127
      len = data.byteslice(2, 8).unpack1('Q>')
      offset = 10
    end
    mask_key = masked ? data.byteslice(offset, 4) : nil
    offset += 4 if masked
    payload = data.byteslice(offset, len) || ""
    if masked && mask_key
      payload = unmask(payload, mask_key)
    end

    case opcode
    when 0x8 # close
      remove_client(client)
    when 0x9 # ping -> pong
      send_pong(client, payload)
    when 0x1, 0x0 # text / continuation
      handle_command(client, payload.force_encoding('UTF-8'))
    end
  end

  def self.unmask(payload, mask)
    bytes = payload.bytes
    bytes.each_with_index.map { |b, i| (b ^ mask.getbyte(i % 4)) }.pack('C*')
  end

  def self.send_pong(client, payload)
    frame = [0x8A].pack('C') + [payload.bytesize].pack('C') + payload
    client.write(frame)
  end

  # 处理画布发来的命令。
  def self.handle_command(client, text)
    begin
      msg = JSON.parse(text) rescue {}
      case msg['type']
      when 'get_camera'
        send_to(client, camera_payload)
      when 'snapshot'
        w = msg['width'].to_i
        w = 320 if w <= 0
        send_snapshot(client, w)
      when 'get_models'
        send_to(client, models_payload)
      when 'get_scenes'
        send_to(client, scenes_payload)
      when 'set_aspect'
        @aspect_w = msg['w'].to_i
        @aspect_h = msg['h'].to_i
      end
    rescue => e
      puts "[CanvasSync] 命令处理失败：#{e.message}"
    end
  end

  # 相机参数。
  def self.camera_payload
    model = Sketchup.active_model
    return { type: 'camera', error: 'no_model' } unless model
    view = model.active_view
    cam = view.camera
    eye = cam.eye
    target = cam.target
    up = cam.up
    {
      type: 'camera',
      eye: [eye.x, eye.y, eye.z],
      target: [target.x, target.y, target.z],
      up: [up.x, up.y, up.z],
      fov: cam.fov.to_f,
      aspect_ratio: cam.aspect_ratio.to_f,
      perspective: cam.perspective?,
      vpwidth: view.vpwidth,
      vpheight: view.vpheight,
    }
  end

  # 模型列表（组件/群组 + 图层）。
  def self.models_payload
    model = Sketchup.active_model
    return { type: 'models', items: [] } unless model
    items = []
    model.definitions.each do |defn|
      next if defn.image? || defn.group?
      items << { name: defn.name, type: 'component', instances: defn.instances.length }
    end
    { type: 'models', items: items }
  end

  # 场景列表。
  def self.scenes_payload
    model = Sketchup.active_model
    return { type: 'scenes', items: [] } unless model
    items = model.pages.map { |p| p.name }
    { type: 'scenes', items: items }
  end

  # 广播相机参数给所有客户端。
  def self.broadcast_camera
    return if @clients.empty?
    payload = camera_payload
    @broadcast_seq += 1
    # 每 5 次 tick（约 250ms）广播一次，避免过于频繁。
    if @broadcast_seq % 5 == 0
      text = JSON.generate(payload)
      @clients.dup.each { |c| send_to(c, text) }
    end
  end

  # 截图并发送。
  def self.send_snapshot(client, width)
    model = Sketchup.active_model
    unless model
      send_to(client, { type: 'snapshot', error: 'no_model' }.to_json)
      return
    end
    view = model.active_view
    # 按当前长宽比计算高度。
    height = (width * @aspect_h.to_f / @aspect_w.to_f).round
    path = File.join(Dir.tmpdir, "canvas_sync_snap_#{width}.png")
    view.write_image(path, width, height, true, true)
    data = File.binread(path)
    File.delete(path) rescue nil
    b64 = Base64.strict_encode64(data)
    send_to(client, { type: 'snapshot', width: width, height: height, mime: 'image/png', data: "data:image/png;base64,#{b64}" }.to_json)
  end

  # 发送 WebSocket 文本帧（服务端到客户端，不 mask）。
  def self.send_to(client, text)
    payload = text.dup.force_encoding('BINARY')
    len = payload.bytesize
    header = if len < 126
      [0x81, len].pack('CC')
    elsif len < 65536
      [0x81, 126, len].pack('CCn')
    else
      [0x81, 127, len].pack('CCQ>')
    end
    client.write(header + payload)
  rescue => e
    remove_client(client)
  end

  def self.remove_client(client)
    @clients.delete(client)
    client.close rescue nil
    puts "[CanvasSync] 客户端断开"
  end

  # ── 菜单 ──
  unless file_loaded?(__FILE__)
    menu = UI.menu('扩展程序')
    menu.add_item('CanvasSync：启动/停止同步服务') { toggle }
    menu.add_item('CanvasSync：截图测试(320)') {
      start unless running?
      sleep 0.1
      send_snapshot(@clients.first, 320) if @clients.any?
    }
    file_loaded(__FILE__)
  end
end

# ── 标准扩展注册（SketchUp 2026 要求）──
unless defined?(SketchUpCanvasSync::REGISTERED)
  extension = SketchupExtension.new('CanvasSync', __FILE__)
  extension.description = 'SketchUp 与 Infinite Canvas 实时联动（相机同步 + 截图）'
  extension.version     = '0.1.0'
  extension.creator     = 'CanvasSync'
  extension.copyright   = '2026'
  Sketchup.register_extension(extension, true)
  SketchUpCanvasSync::REGISTERED = true
end
