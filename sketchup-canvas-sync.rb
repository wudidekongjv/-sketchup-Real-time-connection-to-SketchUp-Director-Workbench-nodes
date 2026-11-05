# frozen_string_literal: true

require 'sketchup.rb'
require 'extensions.rb'

module SketchUpCanvasSync
  EXTENSION_NAME = 'CanvasSync - Infinite Canvas Live Link'
  EXTENSION_ID = 'canvassync.live_link'

  unless file_loaded?(__FILE__)
    extension = SketchupExtension.new(EXTENSION_NAME, 'sketchup-canvas-sync/main')
    extension.description = 'SketchUp 与 Infinite Canvas 实时联动（相机同步 + 截图）。'
    extension.version = '0.1.0'
    extension.creator = 'CanvasSync'
    extension.copyright = '2026'
    Sketchup.register_extension(extension, true)
    file_loaded(__FILE__)
  end
end
