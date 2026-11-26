// Cua Driver 0.59.4, upstream tag cua-driver-rs-v0.59.4.
// Release assets were independently hashed; file hashes were computed only
// after each complete archive matched its published SHA-256. See README.md.
const file = (size, sha256, mode = null) => Object.freeze({ size, sha256, mode });
const unixLicense = file(1069, 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9', 0o644);
const unixNotices = file(9965, '5860ee54b73d3d84f8af8a3c3fc996739755297d91e259314416378548ee8f6d', 0o644);
const unixAbi = file(7762, 'e952620e41ac81b2d900886c7b0a24ebc6268a4edb8df88cc9971ae34af4ba0d', 0o644);
const winLicense = file(1090, 'd0a32419a44fa38d5023d1431dfcbedd1457eb5e7b2e6c7c87ca064facb41b41');
const winNotices = file(10006, '5b466bf3308a54f3f06494b1e2b4c2d2e0bf9a5f58508118d536649a2b378b45');
const winAbi = file(7998, 'c17169f41da321baa5e7e953323c3ad660b00790176ba381e93189fba3506587');
const wayland = Object.freeze({
  'wayland-helper/install.sh': file(1932, '1f36c163562d8d7a3a711e69625adc33895a511a1ca0f2bb8f516c3aca0906fb', 0o755),
  'wayland-helper/winrects@cua/metadata.json': file(231, '1853170d66280f1a096af0e33bb400e3740cddf07bf3e2f1e3bbeaf33550e1d0', 0o644),
  'wayland-helper/winrects@cua/extension.js': file(41902, '80903729beb0f4d87fc6e70ee302e969706c70e05ce41e268e5bae87ca43ac4e', 0o644),
  'wayland-helper/README.md': file(8974, '359bc52eb9639b7242a05d597e4a2ac6d0ea91622d4d4eed89412b594d5f2e17', 0o644)
});

export const DRIVER_VERSION = '0.59.4';
export const DRIVER_COMMIT = '01207bbf0ddcc0f2bb9642322c4e8b4b02319d1b';
export const RELEASE_URL = 'https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.59.4';
const DOWNLOAD_ROOT = 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.59.4/';
function asset(name, size, sha256, files) {
  return Object.freeze({ name, size, sha256, files: Object.freeze(files),
    url: DOWNLOAD_ROOT + name, root: name.replace(/\.tar\.gz$|\.zip$/, ''),
    format: name.endsWith('.zip') ? 'zip' : 'tar.gz', directoryMode: name.endsWith('.zip') ? null : 0o755 });
}
const windowsX64 = asset('cua-driver-rs-0.59.4-windows-x86_64.zip', 32657457, '6ebe56f45a58a9ee7725878b93a824a3a0003e1812f0c3abdee39d679325f0f0', {
  'cua_driver_abi.h': winAbi, 'LICENSE': winLicense, 'THIRD_PARTY_NOTICES.md': winNotices,
  'cua_driver_node_runtime.node': file(637776, '77b431f460746447ef305e05b4dfee328f70f596d78b50095265b64e56cab0c1'),
  'cua_driver_sdk.dll': file(27853128, '40163fdc73e0680fba71f8e758d28fe4be1dc9ee4074ee9bf344ca0a22bb3e70'),
  'cua-cursor-theme.exe': file(1824072, '1cec0da71395fbb9de6a1134ba062c8e37dbea41415e57491ff636c7c530433a'),
  'cua-driver-uia.exe': file(22223184, '1401fbd4182d3643c93f179beb3098c076c44329cc3d551c213ee2e5756379be'),
  'cua-driver.exe': file(33447248, '68b7f1ededdc117970bd6846073773c319c5b97f639c28996d33ba44f24d022b')
});
const windowsArm64 = asset('cua-driver-rs-0.59.4-windows-arm64.zip', 30407435, '386ee7b5b353e6544050da39f9e1145ed6f13706672b2ce50f3cca8cc8ba6f32', {
  'cua_driver_abi.h': winAbi, 'LICENSE': winLicense, 'THIRD_PARTY_NOTICES.md': winNotices,
  'cua_driver_node_runtime.node': file(585552, '751a4bbeed1824ef9969d33982feba2d61a69805d98c8f3fc48f2d117fc7e8f7'),
  'cua_driver_sdk.dll': file(23712080, '36d989e6158890058c001f2d6a85cb1639204f0cb5893e3ce191d09196f18385'),
  'cua-cursor-theme.exe': file(1563984, '0aaaf539f368c33fd39660484388acb52ed74191c9b960367ecd27802479cab5'),
  'cua-driver-uia.exe': file(19370320, '96c14c7c65b56b0285edf0d0c821fddcbce9e70eabd91a5a4bc1e5cbe60a2cf1'),
  'cua-driver.exe': file(28654416, 'ad58f96267ebdace69928cf14782403a7ce748b7dd82edc339aa36d541d580ce')
});
const linuxX64 = asset('cua-driver-rs-0.59.4-linux-x86_64.tar.gz', 30454551, '9bf86d78dff1fd501d4981f7237b2460a274438c758da6c285d954a13ab765b4', {
  'LICENSE': unixLicense, 'THIRD_PARTY_NOTICES.md': unixNotices, 'cua_driver_abi.h': unixAbi, ...wayland,
  'cua-cursor-theme': file(2167088, '378430b96c901d42931aa1b40b1075f4788a4e7ff3f302ffabf1d43fa08e6dad', 0o755),
  'cua_driver_node_runtime.node': file(972672, 'e662b9e1964bab7d049c6907541336d9ec49195c83a4af5a6d7543ffc2409db2', 0o755),
  'libcua_driver_sdk.so': file(32531640, '16a70649d8d740fda22740f4f3934bd8694844aad1954aa64e032b9fd301894f', 0o755),
  'cua-driver': file(37707056, '2ce1833bacba4275443f5dd4dbd764ddcf2a81acb5640fcc619c5b414f4f95ec', 0o755)
});
const linuxArm64 = asset('cua-driver-rs-0.59.4-linux-arm64.tar.gz', 28352004, '9ddf6263463ab505a3b330532d0e3c3b477b281e11f3598fc6355ab334ad49ce', {
  'LICENSE': unixLicense, 'THIRD_PARTY_NOTICES.md': unixNotices, 'cua_driver_abi.h': unixAbi, ...wayland,
  'cua-cursor-theme': file(1827440, '7a8269752787200aa6074ba5fc54d74e41096ad036031a0cfd1db6f4cf351f57', 0o755),
  'cua_driver_node_runtime.node': file(1009088, 'bb4e2bf8f22a3e432daac4e9b0d9447b7237c81f49f4fb43ebce6c9ddc6b2b19', 0o755),
  'libcua_driver_sdk.so': file(28487152, 'c4cbf37610ff7fa2ee5c51bc138aefb971ba4d323cf34678e27017b7bb11dc20', 0o755),
  'cua-driver': file(33172368, '850bd05a4dacd233e178023cb291fc8aae6c65bf9ad26987f588cf8db70ba2ec', 0o755)
});
const darwinUniversal = asset('cua-driver-rs-0.59.4-darwin-universal.tar.gz', 70644449, '9f3579df27542b744bd7572b6f3fed79c90f758f8074da66749ed0a847b6ee8c', {
  'LICENSE': unixLicense, 'THIRD_PARTY_NOTICES.md': unixNotices, 'cua_driver_abi.h': unixAbi,
  'cua-driver': file(53612560, '5e5eecb44c7b27d908fd2ece754efe7d085417b8728eee42a62d1c47a22f0f7b', 0o755),
  'cua_driver_node_runtime.node': file(1774592, '6fc2df4350ccb8eb385199b15027a870227caf315f7e2a96272dcab29654198d', 0o755),
  'cua-cursor-theme': file(3683808, 'c4785f62af039e2bd0539a2ee83f3b7e2c76c9a40d62139371a21a8db9172d18', 0o755),
  'libcua_driver_sdk.dylib': file(42915840, '1eac76f8c67c4ac5a77ea9a7fc8a9be71e152dc571c1b2218a56ba34e3da0147', 0o755),
  'CuaDriver.app/Contents/CodeResources': file(1716, '5ace31890bb28f8e4f8bc7099d88d54442956f24701c3a90bdca16d3e299c2c1', 0o644),
  'CuaDriver.app/Contents/embedded.provisionprofile': file(12308, '6d0ef96f919a526c5245089d62319f53c81345a0a92cc3ef2a5911ca2e871b91', 0o644),
  'CuaDriver.app/Contents/Info.plist': file(1223, 'f619ab1e5302fe2335405da52d735b197583a59df06ddf29dd4665a1ad2b9a41', 0o644),
  'CuaDriver.app/Contents/Resources/AppIcon.icns': file(687131, 'a23ece4fd5e883b511890fd917f3480141aa20a73ed1a862a98c50de984ab793', 0o644),
  'CuaDriver.app/Contents/MacOS/cua-driver': file(53612880, '4ff3543360c64fe9bf5480f4a35ff55c63d6ba9278ad2f945f7aee6c1367905e', 0o755),
  'CuaDriver.app/Contents/MacOS/cua-cursor-theme': file(3683808, 'c4785f62af039e2bd0539a2ee83f3b7e2c76c9a40d62139371a21a8db9172d18', 0o755),
  'CuaDriver.app/Contents/_CodeSignature/CodeResources': file(2999, '846d5b5e8bbced4b7c7aa5259ef52c87eb9b5bab7e51f7b7c1431581d0313e2c', 0o644)
});

const ASSETS = Object.freeze({
  'win32-x64': windowsX64, 'win32-arm64': windowsArm64,
  'linux-x64': linuxX64, 'linux-arm64': linuxArm64,
  'darwin-x64': darwinUniversal, 'darwin-arm64': darwinUniversal
});
export function resolveAsset(platform = process.platform, arch = process.arch) {
  const result = ASSETS[`${platform}-${arch}`];
  if (!result) throw new Error(`No pinned Cua Driver ${DRIVER_VERSION} asset for ${platform}/${arch}`);
  return result;
}
export function supportedTargets() { return Object.keys(ASSETS); }
