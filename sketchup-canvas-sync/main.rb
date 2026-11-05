# frozen_string_literal: true
# CanvasSync 实际逻辑 —— 由主文件 sketchup-canvas-sync.rb 加载。

require 'sketchup.rb'
require 'socket'
require 'json'
require 'base64'
require 'digest'
require 'thread'

module SketchUpCanvasSync
  HOST = '127.0.0.1'
  PORT = 8899

  @server = nil
  @clients = []
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
        @clients.each { |c| c.close rescue nil }
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
      read_messages
    end

    def accept_clients
      return unless @server
      loop do
        begin
          client = @server.accept_nonblock
        rescue IO::WaitReadable, Errno::EAGAIN, Errno::EWOULDBLOCK
          break
        rescue => e
          break
        end
        client.setsockopt(Socket::IPPROTO_TCP, Socket::TCP_NODELAY, 1)
        @mutex.synchronize { @clients << client }
        puts "[CanvasSync] 客户端连接：#{client.peeraddr[3]}"
      end
    end

    def read_messages
      @mutex.synchronize do
        @clients.each do |client|
          begin
            data = client.read_nonblock(65536)
            handle_data(client, data)
          rescue IO::WaitReadable, Errno::EAGAIN, Errno::EWOULDBLOCK
            # 暂无数据
          rescue => e
            remove_client(client)
          end
        end
      end
    end

    def handle_data(client, data)
      if data.include?('Sec-WebSocket-Key')
        do_handshake(client, data)
      else
        parse_frames(client, data)
      end
    end

    def do_handshake(client, data)
      key = data[/Sec-WebSocket-Key:\s*([^\r\n]+)/i, 1]
      return unless key
      accept = Base64.strict_encode64(Digest::SHA1.digest(key.strip + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))
      response = "HTTP/1.1 101 Switching Protocols\r\n" \
                 "Upgrade: websocket\r\n" \
                 "Connection: Upgrade\r\n" \
                 "Sec-WebSocket-Accept: #{accept}\r\n\r\n"
      client.write(response)
      client.instance_variable_set(:@ws_ready, true)
      puts '[CanvasSync] WebSocket 握手完成'
    end

    def parse_frames(client, data)
      return if data.bytesize < 2
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
      payload = data.byteslice(offset, len) || ''
      payload = unmask(payload, mask_key) if masked && mask_key

      case opcode
      when 0x8 then remove_client(client)
      when 0x9 then send_frame(client, 0x8A, payload)
      when 0x1, 0x0 then handle_command(client, payload.force_encoding('UTF-8'))
      end
    end

    def unmask(payload, mask)
      bytes = payload.bytes
      bytes.each_with_index.map { |b, i| (b ^ mask.getbyte(i % 4)) }.pack('C*')
    end

    def handle_command(client, text)
      msg = JSON.parse(text) rescue {}
      case msg['type']
      when 'get_camera'   then send_json(client, camera_payload)
      when 'snapshot'     then send_snapshot(client, msg['width'].to_i)
      when 'get_models'   then send_json(client, models_payload)
      when 'get_scenes'   then send_json(client, scenes_payload)
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

    def send_snapshot(client, width)
      width = 320 if width <= 0
      model = Sketchup.active_model
      unless model
        send_json(client, { type: 'snapshot', error: 'no_model' })
        return
      end
      view = model.active_view
      height = (width * @aspect_h.to_f / @aspect_w.to_f).round
      path = File.join(Dir.tmpdir, "canvas_sync_snap_#{width}.png")
      ok = view.write_image(path, width, height)
      unless ok && File.exist?(path)
        send_json(client, { type: 'snapshot', error: 'write_image failed' })
        return
      end
      data = File.binread(path)
      File.delete(path) rescue nil
      b64 = Base64.strict_encode64(data)
      send_json(client, { type: 'snapshot', width: width, height: height, mime: 'image/png', data: "data:image/png;base64,#{b64}" })
    rescue => e
      send_json(client, { type: 'snapshot', error: e.message })
    end

    def send_json(client, obj)
      send_frame(client, 0x81, JSON.generate(obj))
    end

    def send_frame(client, opcode, payload)
      payload = payload.dup.force_encoding('BINARY')
      len = payload.bytesize
      header = if len < 126
        [opcode, len].pack('CC')
      elsif len < 65536
        [opcode, 126, len].pack('CCn')
      else
        [opcode, 127, len].pack('CCQ>')
      end
      client.write(header + payload)
    rescue => e
      remove_client(client)
    end

    def remove_client(client)
      @clients.delete(client)
      client.close rescue nil
      puts '[CanvasSync] 客户端断开'
    end
  end

  # ── 菜单 ──
  unless file_loaded?(__FILE__)
    menu = UI.menu('扩展程序')
    menu.add_item('CanvasSync：启动/停止同步服务') { toggle }
    file_loaded(__FILE__)
  end
end
