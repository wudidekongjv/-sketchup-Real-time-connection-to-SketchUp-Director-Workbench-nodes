# frozen_string_literal: true
# CanvasSync 实际逻辑 —— 由主文件 sketchup-canvas-sync.rb 加载。
# 通信：本地 WebSocket 服务（127.0.0.1:8899），带完整帧缓冲与状态机。

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

  @server = nil
  @clients = []          # 每个 client 附带 @rbuf（读缓冲）
  @mutex = Mutex.new
  @running = false
  @timer_id = nil
  @aspect_w = 16
  @aspect_h = 9

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
      @timer_id = nil
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

    # ── 主循环（50ms 一次）──
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
        puts "[CanvasSync] TCP 客户端连接：#{sock.peeraddr[3]}"
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

    # 处理某个连接的读缓冲：先握手，后解析帧。
    def process_buffer(c)
      sock = c[:socket]
      # 1) 未握手：等待完整的 HTTP 请求头（\r\n\r\n 结尾）。
      unless c[:handshaken]
        idx = c[:rbuf].index("\r\n\r\n")
        return unless idx
        header = c[:rbuf][0, idx + 4]
        c[:rbuf] = c[:rbuf][(idx + 4)..-1] || ''.b
        do_handshake(sock, header)
        c[:handshaken] = true
      end
      # 2) 解析帧（循环，直到缓冲里没有完整帧）。
      loop do
        frame = extract_frame(c[:rbuf])
        break unless frame
        opcode, payload = frame
        dispatch(sock, opcode, payload)
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

    # 从缓冲提取一个完整帧，返回 [opcode, payload]；缓冲不足返回 nil。
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
      # 从缓冲移除这一帧。
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
      when 0x8 # close
        remove_client_by_socket(sock)
      when 0x9 # ping -> pong
        send_frame(sock, 0x8A, payload)
      when 0x1, 0x0 # text / continuation
        handle_command(sock, payload.force_encoding('UTF-8'))
      end
    end

    def handle_command(sock, text)
      msg = JSON.parse(text) rescue {}
      case msg['type']
      when 'get_camera'   then send_json(sock, camera_payload)
      when 'snapshot'     then send_snapshot(sock, msg['width'].to_i)
      when 'get_models'   then send_json(sock, models_payload)
      when 'get_scenes'   then send_json(sock, scenes_payload)
      when 'set_aspect'
        @aspect_w = msg['w'].to_i if msg['w'].to_i > 0
        @aspect_h = msg['h'].to_i if msg['h'].to_i > 0
      end
    rescue => e
      puts "[CanvasSync] 命令处理失败：#{e.class}: #{e.message}"
    end

    def camera_payload
      model = Sketchup.active_model
      return { type: 'camera', error: 'no_model' } unless model
      cam = model.active_view.camera
      eye = cam.eye
      target = cam.target
      up = cam.up
      {
        type: 'camera',
        eye: [eye.x.to_f, eye.y.to_f, eye.z.to_f],
        target: [target.x.to_f, target.y.to_f, target.z.to_f],
        up: [up.x.to_f, up.y.to_f, up.z.to_f],
        fov: cam.fov.to_f,
        aspect_ratio: cam.aspect_ratio.to_f,
        perspective: cam.perspective?,
      }
    rescue => e
      { type: 'camera', error: e.message }
    end

    def models_payload
      model = Sketchup.active_model
      return { type: 'models', items: [] } unless model
      items = []
      model.definitions.each do |defn|
        next if defn.image? || defn.group?
        items << { name: defn.name, type: 'component', instances: defn.instances.length }
      end
      { type: 'models', items: items }
    rescue => e
      { type: 'models', items: [], error: e.message }
    end

    def scenes_payload
      model = Sketchup.active_model
      return { type: 'scenes', items: [] } unless model
      items = model.pages.map(&:name)
      { type: 'scenes', items: items }
    rescue => e
      { type: 'scenes', items: [], error: e.message }
    end

    def send_snapshot(sock, width)
      width = 320 if width <= 0
      model = Sketchup.active_model
      unless model
        send_json(sock, { type: 'snapshot', error: 'no_model' })
        return
      end
      view = model.active_view
      height = (width * @aspect_h.to_f / @aspect_w.to_f).round
      path = File.join(Dir.tmpdir, "canvas_sync_snap_#{width}.png")
      ok = view.write_image(path, width, height)
      unless ok && File.exist?(path)
        send_json(sock, { type: 'snapshot', error: 'write_image failed' })
        return
      end
      data = File.binread(path)
      File.delete(path) rescue nil
      b64 = Base64.strict_encode64(data)
      send_json(sock, { type: 'snapshot', width: width, height: height, mime: 'image/png', data: "data:image/png;base64,#{b64}" })
    rescue => e
      send_json(sock, { type: 'snapshot', error: e.message })
    end

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

  # ── 菜单（注意：UI.menu 需要英文菜单名 'Plugins'，SketchUp 会自动显示为「扩展程序」）──
  unless file_loaded?(__FILE__)
    menu = UI.menu('Plugins').add_submenu('CanvasSync')
    menu.add_item('启动/停止同步服务') { toggle }
    file_loaded(__FILE__)
  end
end
