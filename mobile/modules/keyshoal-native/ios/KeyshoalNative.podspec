Pod::Spec.new do |s|
  s.name             = 'KeyshoalNative'
  s.version          = '0.1.0'
  s.summary          = 'Private Keyshoal vault storage and Bonjour peer sync'
  s.homepage         = 'https://github.com/frk2/keyshoal'
  s.author           = 'Keyshoal contributors'
  s.license          = { :type => 'UNLICENSED' }
  s.platforms        = { :ios => '16.4' }
  s.source           = { :git => 'https://github.com/frk2/keyshoal.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files     = '**/*.swift'
  s.swift_version    = '5.9'
end
